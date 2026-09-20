import pytest

from meshtalk.instance_lock import InstanceLock


def test_concurrent_backend_cannot_claim_same_directory(tmp_path):
    with InstanceLock(tmp_path):
        with pytest.raises(RuntimeError, match="already owns"):
            InstanceLock(tmp_path)
    with InstanceLock(tmp_path):
        pass


def test_independent_profiles_can_run_together(tmp_path):
    with InstanceLock(tmp_path / "a"), InstanceLock(tmp_path / "b"):
        pass
