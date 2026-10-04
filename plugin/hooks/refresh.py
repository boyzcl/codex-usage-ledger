#!/usr/bin/env python3
"""Trigger only. Never read the hook's transcript-bearing stdin or compute usage."""
import os
from pathlib import Path
# A marker is handled by the watcher. Polling remains the recovery path.
root = Path(os.environ.get('CUX_HOME', str(Path.home() / '.codex-usage-ledger')))
if root.is_dir():
    marker = root / 'refresh.request'
    if not marker.is_symlink():
        marker.touch(mode=0o600, exist_ok=True)
