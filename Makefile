# One-command dev loop. Windows without make: run the commands below by hand (see README "Development").
PY ?= $(if $(wildcard backend/.venv/Scripts/python.exe),backend/.venv/Scripts/python,backend/.venv/bin/python)

.PHONY: setup check lint test test-backend test-frontend typecheck fmt dev-backend dev-frontend

setup:
	cd backend && python -m venv .venv
	$(PY) -m pip install -r backend/requirements-dev.txt
	cd frontend && npm ci

check: lint typecheck test  ## everything CI runs

lint:
	cd backend && ../$(PY) -m ruff check .

fmt:
	cd backend && ../$(PY) -m ruff check --fix .

typecheck:
	cd frontend && npm run typecheck

test: test-backend test-frontend

test-backend:
	cd backend && ../$(PY) -m pytest

test-frontend:
	cd frontend && npm test

dev-backend:
	cd backend && ../$(PY) -m uvicorn app.main:app --port 8000 --reload

dev-frontend:
	cd frontend && npm run dev
