from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
	response = client.get("/health")
	assert response.status_code == 200
	payload = response.json()
	assert payload["status"] == "ok"
	assert payload["graph"] == "stub"


def test_ask_stub() -> None:
	response = client.post(
		"/v1/ask",
		json={"question": "病假需要在几天内补交证明？", "library_id": "lib-hr"},
	)
	assert response.status_code == 200
	payload = response.json()
	assert "三个工作日" in payload["answer"]
	assert len(payload["citations"]) >= 1
	assert payload["mode"] == "stub"
