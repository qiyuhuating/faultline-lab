"""Optional numerical cross-check; Python is not a server or core-test dependency."""
import argparse
import hashlib
import json
import math
import random
import subprocess
from fractions import Fraction
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--node', default='node')
args = parser.parse_args()
repo = Path(__file__).resolve().parent.parent
output = repo / 'test-results/summation-reference'
output.mkdir(parents=True, exist_ok=True)
rng = random.Random(1251074)
cases = []
for case in range(256):
    values = []
    for item in range(32):
        exponent = rng.randint(-1074, 39)
        value = math.ldexp(rng.random(), exponent)
        if rng.randrange(2):
            value = -value
        values.extend([value, -value, math.ldexp(rng.random(), rng.randint(-1074, 39))])
    rng.shuffle(values)
    exact = sum((Fraction.from_float(value) for value in values), Fraction())
    cases.append({'values': values, 'sum': float(exact)})
script = """import { execute } from './src/handlers.mjs';
import { readFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(cases.map(({values}) => execute('csv_summary', values.join(',')).sum)));
"""
actual = json.loads(subprocess.check_output([args.node, '--input-type=module', '-e', script], cwd=repo, input=json.dumps(cases).encode()))
assert len(actual) == len(cases)
for index, (result, case) in enumerate(zip(actual, cases)):
    assert result == case['sum'], (index, result, case['sum'])
data = json.dumps(cases, separators=(',', ':')).encode() + b'\n'
(output / 'inputs.json').write_bytes(data)
report = {'status': 'PASS', 'seed': 1251074, 'cases': len(cases), 'valuesPerCase': 96, 'exponents': [-1074, 39], 'oracle': 'Python fractions.Fraction.from_float; exact rational sum then float once', 'inputSha256': hashlib.sha256(data).hexdigest()}
(output / 'report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
