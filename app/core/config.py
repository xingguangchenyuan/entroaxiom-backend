"""应用配置：全部来自环境变量（或项目根目录的 .env），密钥与密码哈希不进代码、不进 Git。"""

from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

DEV_FALLBACK_SECRET = "dev-insecure-secret-do-not-use-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # 运行环境：prod 会启用严格的启动检查
    app_env: Literal["dev", "test", "prod"] = "dev"

    # 签名 Cookie 用的密钥（≥32 字符随机串）。更换它会让所有已登录会话立即失效
    secret_key: str = ""
    # 管理员密码的 argon2 哈希，用 scripts/hash_password.py 生成。只存哈希，不存明文
    admin_password_hash: str = ""

    database_url: str = "sqlite:///./data/entroaxiom.db"
    # 上传根目录，内部分 public/ private/ tmp/
    upload_dir: Path = Path("./uploads")
    max_upload_mb: int = Field(default=50, ge=1, le=2048)

    cookie_name: str = "entro_session"
    # 生产必须为 true（仅 HTTPS 发送）。本地 http 开发可设为 false
    cookie_secure: bool = True
    session_max_age_days: int = Field(default=7, ge=1, le=90)

    # /api/docs 自带接口文档：仅开发使用，生产保持 false
    enable_docs: bool = False
    # 由后端自己提供 /uploads/public/*。开发时需要（没有 Nginx）；生产由 Nginx 提供，应为 false
    serve_public_uploads: bool = False
    # 位于 Nginx 之后时为 true，使用 X-Real-IP 识别客户端 IP（用于登录限流）
    trust_proxy: bool = False
    # 允许发起写操作的来源，逗号分隔，如 https://example.com。留空则要求与 Host 同源
    allowed_origins: str = ""

    login_max_failures: int = Field(default=5, ge=1, le=100)
    login_window_minutes: int = Field(default=15, ge=1, le=1440)

    # 用于生成"今天"的日期（内容的 date / updated），服务器常为 UTC，这里按你所在时区算
    timezone: str = "Asia/Shanghai"
    log_level: str = "INFO"

    # ---- 派生值 ----
    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def session_max_age_seconds(self) -> int:
        return self.session_max_age_days * 86400

    @property
    def login_window_seconds(self) -> int:
        return self.login_window_minutes * 60

    @property
    def allowed_origin_list(self) -> list[str]:
        return [o.strip().rstrip("/").lower() for o in self.allowed_origins.split(",") if o.strip()]

    @property
    def effective_secret(self) -> str:
        return self.secret_key or DEV_FALLBACK_SECRET

    @property
    def is_prod(self) -> bool:
        return self.app_env == "prod"

    def today(self) -> date:
        """按配置时区取今天的日期；时区数据库缺失时退回 UTC。"""
        try:
            from zoneinfo import ZoneInfo

            return datetime.now(ZoneInfo(self.timezone)).date()
        except Exception:  # noqa: BLE001 - tzdata 缺失等情况
            return datetime.now(timezone.utc).date()

    def validate_for_runtime(self) -> list[str]:
        """启动检查。prod 下不合格直接抛错；返回需要提示的警告列表。"""
        warnings: list[str] = []
        if self.is_prod:
            problems: list[str] = []
            if len(self.secret_key) < 32:
                problems.append("SECRET_KEY 必须设置，且至少 32 个字符")
            if not self.admin_password_hash.startswith("$argon2"):
                problems.append("ADMIN_PASSWORD_HASH 必须是 argon2 哈希（用 scripts/hash_password.py 生成）")
            if not self.cookie_secure:
                problems.append("生产环境必须 COOKIE_SECURE=true（并启用 HTTPS）")
            if self.enable_docs:
                warnings.append("生产环境建议 ENABLE_DOCS=false")
            if self.serve_public_uploads:
                warnings.append("生产环境建议 SERVE_PUBLIC_UPLOADS=false，由 Nginx 提供公开文件")
            if problems:
                raise RuntimeError("配置不合格：" + "；".join(problems))
        else:
            if not self.secret_key:
                warnings.append("未设置 SECRET_KEY，正在使用开发用的固定密钥，切勿用于生产")
            if not self.admin_password_hash:
                warnings.append("未设置 ADMIN_PASSWORD_HASH，管理员登录不可用")
        return warnings


@lru_cache
def get_settings() -> Settings:
    return Settings()
