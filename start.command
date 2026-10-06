#!/bin/bash
cd "$(dirname "$0")"
(sleep 2 && open http://localhost:8765) &
.venv/bin/python server.py
