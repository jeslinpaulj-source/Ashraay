import importlib.util
import json
from pathlib import Path
import subprocess
from unittest.mock import Mock

import pytest


@pytest.fixture
def postgres_module():
    path = Path(__file__).resolve().parents[3] / "database" / "local-postgres.py"
    spec = importlib.util.spec_from_file_location("local_postgres_tests", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def config_for(port):
    return {
        "port": port,
        "adminUrl": f"postgresql://admin:demo@127.0.0.1:{port}/postgres",
        "databaseUrl": f"postgresql+asyncpg://app_user:demo@127.0.0.1:{port}/ashraay",
        "agentUrl": f"postgresql://agent:demo@127.0.0.1:{port}/ashraay",
        "apiPassword": "demo",
        "agentPassword": "demo",
    }


def test_endpoint_mismatch_is_explicit(postgres_module):
    with pytest.raises(RuntimeError, match="does not match.*55900"):
        postgres_module.validate_endpoint(config_for(55432), 55900)
    postgres_module.validate_endpoint(config_for(55900), 55900)


@pytest.mark.parametrize("offline_error", [False, True])
def test_password_recovery_preserves_cluster_and_only_saves_successful_config(
    postgres_module, monkeypatch, tmp_path, offline_error
):
    data = tmp_path / "postgres"
    data.mkdir()
    (data / "PG_VERSION").write_text("18")
    config_path = tmp_path / "postgres.json"
    monkeypatch.setattr(postgres_module, "DATA", data)
    monkeypatch.setattr(postgres_module, "CONFIG", config_path)
    monkeypatch.setattr(postgres_module.subprocess, "check_output", Mock(return_value="55900\n"))
    calls = []

    def execute(args, **kwargs):
        calls.append((args, kwargs))
        if "status" in args:
            return subprocess.CompletedProcess(args, 0, "", "")
        return subprocess.CompletedProcess(args, 0, "", "ERROR: test failure" if offline_error else "")

    monkeypatch.setattr(postgres_module.subprocess, "run", execute)
    stop = Mock()
    monkeypatch.setattr(postgres_module, "run", stop)
    writes = {}
    monkeypatch.setattr(postgres_module, "private_file", lambda path, content: writes.update({path: content}))
    original = config_for(55432)
    if offline_error:
        with pytest.raises(RuntimeError, match="cluster remains stopped"):
            postgres_module.reset_passwords(original)
        assert config_path not in writes
    else:
        recovered = postgres_module.reset_passwords(original)
        assert recovered["port"] == 55900
        postgres_module.validate_endpoint(recovered, 55900)
        assert recovered["apiPassword"] != original["apiPassword"]
        assert json.loads(writes[config_path]) == recovered
    stop.assert_called_once_with("pg_ctl", "-D", str(data), "-m", "fast", "-w", "stop")
    offline_args, offline_kwargs = calls[-1]
    assert "--single" in offline_args
    assert "ALTER ROLE admin" in offline_kwargs["input"]
    assert "ALTER ROLE app_user" in offline_kwargs["input"]
    assert "ALTER ROLE agent" in offline_kwargs["input"]
    assert "DROP" not in offline_kwargs["input"]
    assert (data / "PG_VERSION").read_text() == "18"
    assert any("postgres-before-recovery-" in path.name for path in writes)
    assert any("postgres-recovery-" in path.name for path in writes)
