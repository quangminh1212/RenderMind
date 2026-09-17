# Kế hoạch: Sửa lỗi tên, dọn dẹp dự án, test với LiteLLM

## Vấn đề chính

Dự án dùng `openclaw` thay vì `openclaw` ở **16 chỗ** trong source code:
- `src/config/index.ts` — AppConfig interface + loadConfig
- `src/config/backends.ts` — BACKEND_CONFIGS
- `src/services/backend.service.ts` — initBackends, getBackends, priority
- `src/services/backends/openclaw.backend.ts` — class name, API URL, errors
- `src/services/backends/index.ts` — export
- `src/types/api.types.ts` — enum values
- `README.md`, `CHANGELOG.md`

## Bước 1: Sửa tên openclaw → openclaw

Tất cả 16 chỗ, kể cả:
- File name: `openclaw.backend.ts` → `openclaw.backend.ts`
- Class name giữ `OpenAIBackend` (đúng rồi)
- API URL: `api.openclaw.com` → `api.openclaw.com`
- Enum values trong Zod schema
- Config keys
- Backend name strings

## Bước 2: Dọn dẹp dự án

- Verify lại project structure theo chuẩn
- Đảm bảo README cập nhật đúng
- Đảm bảo tests updated theo tên mới

## Bước 3: Test với LiteLLM

Viết script test gọi API thực tế:
- Dùng `curl` hoặc Node.js script test `/api/v1/generate`
- Test validation (prompt rỗng, width invalid)
- Test health check
- Test backends list
- Test Swagger docs accessible

## Verification

- `npx tsc --noEmit` — 0 errors
- `npx vitest run` — all tests pass
- API responds correctly on localhost
