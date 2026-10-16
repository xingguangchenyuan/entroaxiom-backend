"""生成管理员密码的 argon2 哈希，写进 .env 的 ADMIN_PASSWORD_HASH。

用法：python scripts/hash_password.py
密码不会回显，也不会保存；只输出哈希。
"""

import getpass
import sys


def main() -> int:
    try:
        from argon2 import PasswordHasher
    except ImportError:
        print("缺少 argon2-cffi：pip install -r requirements.txt", file=sys.stderr)
        return 1

    password = getpass.getpass("管理员密码（至少 12 位，不会回显）: ")
    if len(password) < 12:
        print("密码太短，请至少 12 位（建议用口令短语）。", file=sys.stderr)
        return 1
    if getpass.getpass("再输入一次: ") != password:
        print("两次输入不一致。", file=sys.stderr)
        return 1

    hashed = PasswordHasher().hash(password)
    print("\n把下面这一行放进 .env（注意两边的单引号，哈希里含 $ 符号，必须加引号）：\n")
    print(f"ADMIN_PASSWORD_HASH='{hashed}'")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
