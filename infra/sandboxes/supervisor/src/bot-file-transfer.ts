// SPDX-FileCopyrightText: 2026 Ork contributors
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

/** Linux dir-fd traversal; stdin EOF retires the process even during a blocked filesystem read. */
export const BOT_FILE_TRANSFER_SCRIPT = `
import base64, os, stat, sys, threading
root, relative, raw_limit, watch_stdin = sys.argv[1:]
limit = int(raw_limit)
if watch_stdin == '1':
  def retire():
    try:
      while os.read(0, 4096): pass
    finally:
      os._exit(125)
  threading.Thread(target=retire, daemon=True).start()
parts = relative.split('/')
if limit < 0 or not parts or any(part in ('', '.', '..') or chr(92) in part or chr(0) in part for part in parts):
  sys.exit(41)
directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
  for part in parts[:-1]:
    child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
    os.close(directory)
    directory = child
  source = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
  try:
    info = os.fstat(source)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1: sys.exit(41)
    if info.st_size > limit: sys.exit(42)
    chunks, total = [], 0
    while True:
      chunk = os.read(source, min(65536, limit - total + 1))
      if not chunk: break
      total += len(chunk)
      if total > limit: sys.exit(42)
      chunks.append(chunk)
    sys.stdout.write(base64.b64encode(b''.join(chunks)).decode())
  finally:
    os.close(source)
finally:
  os.close(directory)
`;
