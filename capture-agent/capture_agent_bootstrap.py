"""PyInstaller entry point for the bundled Needlecast Windows capture agent."""
from capture_agent import app, CAPTURE_AGENT_PORT
import uvicorn

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=CAPTURE_AGENT_PORT, log_level="info")
