"""Recognize the Voice Mode fork in current and older BB manifests."""
import json
from pathlib import Path


def is_voice_fork(plugin):
    if plugin.get('id') != 'voice-mode':
        return False
    policy = Path(__file__).resolve().parents[1] / 'plugins/voice-mode/fork.json'
    repository = json.loads(policy.read_text())['repository']
    return plugin['source'].partition('@')[0] == 'git:' + repository
