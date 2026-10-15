"""Windows-friendly host audio capture agent for Turntable → Discord.

Captures a selected input device with PortAudio, converts it to 48 kHz stereo
signed 16-bit PCM, then sends binary chunks to the local Needlecast audio relay.
"""
from __future__ import annotations

import asyncio
import math
import os
import queue
import threading
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
import sounddevice as sd
import websockets
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

AUDIO_WS_URL = os.environ.get("AUDIO_WS_URL", "ws://127.0.0.1:8765/audio")
CAPTURE_AGENT_PORT = int(os.environ.get("CAPTURE_AGENT_PORT", "8766"))
ALLOWED_ORIGIN = os.environ.get("ALLOWED_ORIGIN", "http://localhost:3000")
SAMPLE_RATE = 48_000
BLOCK_SIZE = 960  # 20 ms at 48 kHz

state_lock = threading.Lock()
state = {
    "streaming": False,
    "connectedToRelay": False,
    "selectedDevice": None,
    "selectedDeviceName": None,
    "gainDb": -12.0,
    "peak": 0.0,
    "rms": 0.0,
    "droppedBlocks": 0,
    "lastError": None,
}

pcm_queue: queue.Queue[Optional[bytes]] = queue.Queue(maxsize=40)
capture_stream: Optional[sd.InputStream] = None
sender_task: Optional[asyncio.Task] = None
connected_event: Optional[asyncio.Event] = None
stop_event = threading.Event()


class StartRequest(BaseModel):
    deviceIndex: Optional[int] = None
    gainDb: float = Field(default=-12.0, ge=-36.0, le=12.0)


class GainRequest(BaseModel):
    gainDb: float = Field(ge=-36.0, le=12.0)


def _patch_state(**updates):
    with state_lock:
        state.update(updates)


def _input_callback(indata, frames, time_info, status_flags):
    del frames, time_info
    if status_flags:
        _patch_state(lastError=f"Audio input warning: {status_flags}")

    if not state["streaming"]:
        return

    try:
        audio = indata
        if audio.shape[1] == 1:
            audio = np.repeat(audio, 2, axis=1)
        elif audio.shape[1] > 2:
            audio = audio[:, :2]

        with state_lock:
            gain_db = float(state["gainDb"])
        gain = 10.0 ** (gain_db / 20.0)
        adjusted = np.clip(audio * gain, -1.0, 1.0)
        peak = float(np.max(np.abs(adjusted))) if adjusted.size else 0.0
        rms = float(np.sqrt(np.mean(np.square(adjusted)))) if adjusted.size else 0.0
        pcm = (adjusted * 32767.0).astype(np.int16, copy=False).tobytes()

        _patch_state(peak=peak, rms=rms)
        try:
            pcm_queue.put_nowait(pcm)
        except queue.Full:
            # Prefer current audio over stale audio if the relay temporarily falls behind.
            try:
                pcm_queue.get_nowait()
                _patch_state(droppedBlocks=state["droppedBlocks"] + 1)
            except queue.Empty:
                pass
            try:
                pcm_queue.put_nowait(pcm)
            except queue.Full:
                pass
    except Exception as exc:  # Never let exceptions escape the real-time callback.
        _patch_state(lastError=f"Audio callback error: {exc}")


def _clear_queue():
    while True:
        try:
            pcm_queue.get_nowait()
        except queue.Empty:
            break


async def _send_audio():
    global connected_event
    try:
        async with websockets.connect(
            AUDIO_WS_URL,
            open_timeout=5,
            ping_interval=20,
            ping_timeout=20,
            max_size=None,
            max_queue=8,
        ) as ws:
            _patch_state(connectedToRelay=True, lastError=None)
            if connected_event:
                connected_event.set()
            while not stop_event.is_set():
                try:
                    chunk = await asyncio.to_thread(pcm_queue.get, True, 0.3)
                except queue.Empty:
                    continue
                if chunk is None:
                    break
                if chunk:
                    await ws.send(chunk)
    except Exception as exc:
        _patch_state(lastError=f"Can't connect to the local audio relay at {AUDIO_WS_URL}: {exc}")
        if connected_event:
            connected_event.set()
    finally:
        _patch_state(connectedToRelay=False)


def _stop_input_stream():
    global capture_stream
    stream, capture_stream = capture_stream, None
    if stream is not None:
        try:
            stream.stop()
        except Exception:
            pass
        try:
            stream.close()
        except Exception:
            pass


async def _stop_capture(clear_error: bool = False):
    global sender_task, connected_event
    stop_event.set()
    _patch_state(streaming=False)
    _stop_input_stream()
    _clear_queue()
    try:
        pcm_queue.put_nowait(None)
    except queue.Full:
        pass
    task, sender_task = sender_task, None
    if task and not task.done():
        try:
            await asyncio.wait_for(task, timeout=1.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            task.cancel()
    connected_event = None
    _patch_state(connectedToRelay=False, peak=0.0, rms=0.0)
    if clear_error:
        _patch_state(lastError=None)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await _stop_capture(clear_error=True)


app = FastAPI(title="Turntable Capture Agent", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN, "http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "host-capture-agent"}


@app.get("/api/devices")
def list_devices():
    try:
        devices = sd.query_devices()
        host_apis = sd.query_hostapis()
        output = []
        for index, device in enumerate(devices):
            input_channels = int(device.get("max_input_channels", 0))
            if input_channels < 1:
                continue
            host_index = int(device.get("hostapi", 0))
            host_name = host_apis[host_index]["name"] if 0 <= host_index < len(host_apis) else "Unknown"
            output.append({
                "index": index,
                "name": str(device.get("name", f"Input {index}")),
                "inputChannels": input_channels,
                "defaultSampleRate": int(device.get("default_samplerate", SAMPLE_RATE)),
                "hostApi": str(host_name),
            })
        default_device = sd.default.device[0]
        return {"devices": output, "defaultInputIndex": int(default_device) if default_device is not None else None}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not enumerate audio inputs: {exc}") from exc


@app.get("/api/status")
def get_status():
    with state_lock:
        return dict(state)


@app.post("/api/gain")
def set_gain(payload: GainRequest):
    _patch_state(gainDb=float(payload.gainDb))
    return {"ok": True, "gainDb": float(payload.gainDb)}


@app.post("/api/start")
async def start_capture(payload: StartRequest):
    global capture_stream, sender_task, connected_event
    if state["streaming"]:
        raise HTTPException(status_code=409, detail="Capture is already running.")

    try:
        devices = sd.query_devices()
        device_index = payload.deviceIndex
        if device_index is None:
            default_index = sd.default.device[0]
            device_index = int(default_index) if default_index is not None and int(default_index) >= 0 else None
        if device_index is not None:
            if device_index < 0 or device_index >= len(devices):
                raise HTTPException(status_code=400, detail="That audio device index is no longer available. Refresh the device list.")
            device_info = devices[device_index]
        elif len(devices) > 0:
            # If Windows has no explicit default input, select the first actual recording device.
            candidates = [i for i, item in enumerate(devices) if int(item.get("max_input_channels", 0)) > 0]
            if not candidates:
                raise HTTPException(status_code=400, detail="No audio input devices were found.")
            device_index = candidates[0]
            device_info = devices[device_index]
        else:
            raise HTTPException(status_code=400, detail="No audio devices were found.")

        input_channels = int(device_info.get("max_input_channels", 0)) if device_info else 2
        if input_channels < 1:
            raise HTTPException(status_code=400, detail="The selected device has no input channels.")
        channels = min(2, input_channels)
        device_name = str(device_info.get("name")) if device_info else "System default input"

        _clear_queue()
        stop_event.clear()
        connected_event = asyncio.Event()
        _patch_state(
            streaming=True,
            connectedToRelay=False,
            selectedDevice=device_index,
            selectedDeviceName=device_name,
            gainDb=float(payload.gainDb),
            peak=0.0,
            rms=0.0,
            droppedBlocks=0,
            lastError=None,
        )
        capture_stream = sd.InputStream(
            device=device_index,
            samplerate=SAMPLE_RATE,
            channels=channels,
            dtype="float32",
            blocksize=BLOCK_SIZE,
            callback=_input_callback,
        )
        capture_stream.start()
        sender_task = asyncio.create_task(_send_audio())
        try:
            await asyncio.wait_for(connected_event.wait(), timeout=6.0)
        except asyncio.TimeoutError:
            await _stop_capture()
            raise HTTPException(
                status_code=503,
                detail="The audio relay did not respond. Make sure the Needlecast backend is running, then try again.",
            )
        if not state["connectedToRelay"]:
            error = state.get("lastError") or "Could not connect to the audio relay."
            await _stop_capture()
            raise HTTPException(status_code=503, detail=error)
        return {"ok": True, "deviceName": device_name, "sampleRate": SAMPLE_RATE, "channels": 2}
    except HTTPException:
        raise
    except Exception as exc:
        await _stop_capture()
        message = str(exc)
        if "Invalid sample rate" in message or "Invalid number of channels" in message:
            message += " Try another input device or set its Windows format to 48,000 Hz in Sound settings."
        _patch_state(lastError=message)
        raise HTTPException(status_code=400, detail=f"Could not start audio capture: {message}") from exc


@app.post("/api/stop")
async def stop_capture():
    await _stop_capture(clear_error=True)
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=CAPTURE_AGENT_PORT, log_level="info")
