"""Guard the hand-written mirror frontend/src/types.ts against drift from app/schemas.py.

For every TS interface whose name matches a Pydantic model, each TS field must exist on the model
(the frontend may read a subset, but never a field the backend does not send). A field that is
required in TS must not be optional-with-no-default on the backend.
"""
import re
import unittest
from pathlib import Path

from pydantic import BaseModel

from app import schemas

TYPES_TS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "types.ts"


def ts_interfaces(src: str) -> dict[str, dict[str, bool]]:
    """{interface: {field: optional}} for top-level `export interface X { ... }` blocks."""
    src = re.sub(r"//[^\n]*", "", src)
    out: dict[str, dict[str, bool]] = {}
    for m in re.finditer(r"export interface (\w+)(?:\s+extends\s+[\w, ]+)?\s*\{", src):
        i, depth = m.end(), 1
        while depth:
            depth += {"{": 1, "}": -1}.get(src[i], 0)
            i += 1
        body, fields, d = src[m.end():i - 1], {}, 0
        member = ""
        for ch in body + ";":
            if ch in "{([<":
                d += 1
            elif ch in "})]>":
                d -= 1
            if ch in ";\n" and d == 0:
                fm = re.match(r"\s*(?:readonly\s+)?(\w+)(\??)\s*:", member)
                if fm:
                    fields[fm.group(1)] = bool(fm.group(2))
                member = ""
            else:
                member += ch
        out[m.group(1)] = fields
    return out


def pydantic_models() -> dict[str, type[BaseModel]]:
    return {n: c for n, c in vars(schemas).items()
            if isinstance(c, type) and issubclass(c, BaseModel) and c.__module__ == schemas.__name__}


class SchemaMirrorTests(unittest.TestCase):
    def setUp(self):
        if not TYPES_TS.exists():
            self.skipTest("frontend not checked out")
        self.ts = ts_interfaces(TYPES_TS.read_text(encoding="utf-8"))
        self.py = pydantic_models()

    def test_parser_sees_the_core_models(self):
        shared = set(self.ts) & set(self.py)
        for name in ("Citation", "Event", "Anomaly", "SourceFile", "CaseGraph"):
            self.assertIn(name, shared)

    def test_ts_fields_exist_on_backend_models(self):
        for name in sorted(set(self.ts) & set(self.py)):
            py_fields = self.py[name].model_fields
            for field in self.ts[name]:
                with self.subTest(model=name, field=field):
                    self.assertIn(field, py_fields, f"types.ts {name}.{field} is not in schemas.py")

    def test_required_ts_fields_are_always_sent(self):
        for name in sorted(set(self.ts) & set(self.py)):
            py_fields = self.py[name].model_fields
            for field, optional in self.ts[name].items():
                if optional or field not in py_fields:
                    continue
                with self.subTest(model=name, field=field):
                    # Pydantic always serialises declared fields (None included), so only
                    # exclusion would break this; a field with no default is required on the backend too.
                    self.assertFalse(py_fields[field].exclude, f"{name}.{field} is excluded from JSON")


if __name__ == "__main__":
    unittest.main()
