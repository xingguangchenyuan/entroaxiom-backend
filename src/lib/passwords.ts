import { Algorithm, hash, verify } from "@node-rs/argon2";

const TIME_COST = 3;
const PARALLELISM = 1;
const OUTPUT_LEN = 32;

function normalize(password: string): string {
  // Unicode 等价形式统一，避免同一个口令因为组合字符不同而校验失败
  return password.normalize("NFKC");
}

export async function hashPassword(password: string, memoryKib: number): Promise<string> {
  return hash(normalize(password), {
    algorithm: Algorithm.Argon2id,
    memoryCost: memoryKib,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
    outputLen: OUTPUT_LEN
  });
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
  memoryKib: number
): Promise<boolean> {
  try {
    return await verify(passwordHash, normalize(password), {
      algorithm: Algorithm.Argon2id,
      memoryCost: memoryKib,
      timeCost: TIME_COST,
      parallelism: PARALLELISM,
      outputLen: OUTPUT_LEN
    });
  } catch {
    return false;
  }
}

/**
 * 用户名不存在时也跑一次等价的哈希运算，
 * 让「用户不存在」与「口令错误」在响应时间上无法区分。
 */
export async function burnPasswordCheck(password: string, memoryKib: number): Promise<void> {
  await hashPassword(`${password}#entropy-burner`, memoryKib).catch(() => undefined);
}
