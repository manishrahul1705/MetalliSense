"""Actual Agent ASGI app with only the external LLM replaced by a labelled fixture.

Run against a disposable copy of the Agent source; never the working model files.
"""
import sys
import os
from datetime import datetime, timezone
from pathlib import Path
import uvicorn

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from app.main import app
import app.main as main


class CopilotFixture:
    def explain_analysis(self, **kwargs):
        return {
            "explanation": "SIMULATED external LLM response for Stage 1 contract verification.",
            "summary": "Fixture response; ML validity UNVERIFIED.",
            "action_items": ["Independent human review required"],
            "risk_level": "LOW", "confidence": 0.0,
            "context": {"fixture": True}, "timestamp": datetime.now(timezone.utc).isoformat()
        }


@app.on_event("startup")
async def install_external_provider_fixture():
    if os.environ.get('STAGE1_EXTERNAL_LLM_FIXTURE') == 'true':
        main.copilot = CopilotFixture()


uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[2]), log_level="warning")
