"""Configuration for MemTensor hermes-agent memory provider."""

from __future__ import annotations

import json
import os

from pathlib import Path


DAEMON_PORT = 18992
VIEWER_PORT = 18901
OWNER = "hermes"


def get_plugin_dir() -> Path:
    return Path(__file__).resolve().parent


def get_hermes_home() -> Path:
    return Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))


def get_memos_state_dir() -> Path:
    env = os.environ.get("MEMOS_STATE_DIR")
    if env:
        return Path(env)
    state_dir = get_hermes_home() / "memos-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    return state_dir


def get_daemon_dir() -> Path:
    d = get_memos_state_dir() / "daemon"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_daemon_port() -> int:
    env = os.environ.get("MEMOS_DAEMON_PORT")
    if env:
        return int(env)
    port_file = get_daemon_dir() / "bridge.port"
    if port_file.exists():
        try:
            return int(port_file.read_text().strip())
        except (ValueError, OSError):
            pass
    return DAEMON_PORT


def get_viewer_port() -> int:
    env = os.environ.get("MEMOS_VIEWER_PORT")
    if env:
        return int(env)
    return VIEWER_PORT


def _read_host_model_config() -> dict:
    """Read embedding/summarizer config from host agent's config as fallback."""
    home = os.environ.get("HOME", os.environ.get("USERPROFILE", ""))
    cfg_path = os.environ.get("OPENCLAW_CONFIG_PATH") or os.path.join(
        os.environ.get("OPENCLAW_STATE_DIR", os.path.join(home, ".openclaw")),
        "openclaw.json",
    )
    try:
        with open(cfg_path) as f:
            raw = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}

    entries = raw.get("plugins", {}).get("entries", {})
    for name, entry in entries.items():
        if "memos" in name.lower():
            cfg = entry.get("config", {})
            result: dict = {}
            if cfg.get("embedding", {}).get("provider"):
                result["embedding"] = cfg["embedding"]
            if cfg.get("summarizer", {}).get("provider"):
                result["summarizer"] = cfg["summarizer"]
            if result:
                return result
    return {}


def get_bridge_config() -> dict:
    """Build configuration dict for the memos-core-bridge process."""
    env_config = os.environ.get("MEMOS_BRIDGE_CONFIG")
    if env_config:
        try:
            return json.loads(env_config)
        except json.JSONDecodeError:
            pass

    state_dir = str(get_memos_state_dir())
    config: dict = {"stateDir": state_dir}
    plugin_config: dict = {}

    embedding_provider = os.environ.get("MEMOS_EMBEDDING_PROVIDER")
    if embedding_provider:
        plugin_config["embedding"] = {"provider": embedding_provider}
        api_key = os.environ.get("MEMOS_EMBEDDING_API_KEY")
        if api_key:
            plugin_config["embedding"]["apiKey"] = api_key
        endpoint = os.environ.get("MEMOS_EMBEDDING_ENDPOINT")
        if endpoint:
            plugin_config["embedding"]["endpoint"] = endpoint

    if "embedding" not in plugin_config:
        oc_config = _read_host_model_config()
        if oc_config.get("embedding"):
            plugin_config["embedding"] = oc_config["embedding"]
        if oc_config.get("summarizer"):
            plugin_config["summarizer"] = oc_config["summarizer"]

    plugin_config["telemetry"] = {"platform": "hermes"}

    if plugin_config:
        config["config"] = plugin_config

    logo_svg = str(get_plugin_dir() / "logo.svg")
    config["branding"] = {
        "title": "Hermes 记忆",
        "titleEn": "Hermes Memory",
        "suffix": "Hermes",
        "favicon": "https://hermes-agent.nousresearch.com/docs/img/favicon.ico",
        "logoSvgPath": logo_svg,
    }

    return config


def _get_plugin_root() -> Path:
    """Return the memos-local-plugin root (two levels up from adapter dir)."""
    return get_plugin_dir().parent.parent


def _resolve_tsx(plugin_root: Path) -> str:
    """Return absolute path to tsx binary, preferring the local node_modules copy."""
    local_tsx = plugin_root / "node_modules" / ".bin" / "tsx"
    if local_tsx.exists():
        return str(local_tsx)
    import shutil

    global_tsx = shutil.which("tsx")
    if global_tsx:
        return global_tsx
    return "npx tsx"


def find_bridge_script() -> list[str]:
    """Locate the bridge.cts entry point and return the command to run it."""
    plugin_dir = get_plugin_dir()
    plugin_root = _get_plugin_root()

    candidates: list[Path] = []

    env_path = os.environ.get("MEMOS_BRIDGE_SCRIPT")
    if env_path:
        candidates.append(Path(env_path))

    bridge_path_file = plugin_dir / "bridge_path.txt"
    if bridge_path_file.exists():
        recorded = bridge_path_file.read_text().strip()
        if recorded:
            candidates.append(Path(recorded))

    candidates.append(plugin_root / "bridge.cts")

    for candidate in candidates:
        if candidate.exists():
            if candidate.suffix == ".js":
                return ["node", str(candidate)]
            tsx = _resolve_tsx(candidate.parent)
            if " " in tsx:
                return [*tsx.split(), str(candidate)]
            return [tsx, str(candidate)]

    raise FileNotFoundError(
        "Cannot locate memos bridge script. Looked in:\n"
        + "\n".join(f"  - {c}" for c in candidates)
    )
