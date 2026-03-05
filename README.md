# 🖼️ Poster Auto-Generation System

**한양맞춤의약연구센터** 고가 의약 실험 장비/실험실 대여 사업을 위한 자동 포스터 생성 시스템.

Google Sheets의 DB를 주기적으로 읽어 고퀄리티 홍보 포스터를 자동 생성하고,
결과를 별도의 시트에 기록합니다.

---

## 🏗️ Architecture

```
Admin UI (Next.js)  ←→  Internal Google Sheet (저장소)  ←→  GitHub Actions Worker
        ↕                         ↕                              ↕
   관리자 설정              config/state/logs                DB/Result Sheet
                                                              Google Drive
```

## 📁 Project Structure

```
poster-auto-generator/
├── .github/workflows/
│   └── poster-worker.yml       # GitHub Actions cron workflow
├── packages/
│   ├── shared/src/              # 공유 라이브러리
│   │   ├── types.ts             # 전체 타입 정의
│   │   ├── sheets-client.ts     # Google Sheets 읽기/쓰기
│   │   ├── drive-uploader.ts    # Google Drive 업로드
│   │   ├── state-manager.ts     # 상태 관리 + 분산 락
│   │   ├── crypto-utils.ts      # AES-256-GCM 암호화
│   │   ├── header-inference.ts  # LLM 기반 헤더 의미 추론
│   │   ├── poster-templates.ts  # 12종 포스터 템플릿
│   │   ├── copy-generator.ts    # LLM 카피 생성
│   │   ├── poster-generator.ts  # 포스터 이미지 생성
│   │   ├── logger.ts            # 실행/행/에러 로깅
│   │   └── index.ts             # barrel export
│   └── worker/src/
│       └── main.ts              # Worker 메인 진입점
└── apps/admin-ui/src/
    ├── app/
    │   ├── page.tsx             # 대시보드
    │   ├── logs/page.tsx        # 로그/에러 뷰어
    │   ├── settings/
    │   │   ├── connection/      # 연결 설정
    │   │   ├── schedule/        # 스케줄 설정
    │   │   ├── mapping/         # 헤더 매핑 UI
    │   │   └── message/         # 고정 문구
    │   └── api/                 # API Routes
    └── lib/
        ├── api.ts               # 클라이언트 API 헬퍼
        └── sheets-service.ts    # 서버 사이드 시트 서비스
```

## 🔑 Key Features

### 🎯 Zero Forced Columns (핵심)
- 시트 컬럼명/헤더를 일절 강제하지 않음
- Gemini LLM이 헤더를 읽고 의미를 추론 → 관리자가 UI에서 확인/수정/확정
- 헤더가 변경되면 자동으로 재매핑 필요 상태 전환

### 📊 3-Tier Result Save Strategy
1. **분산 저장**: 기존 헤더 중 의미 매칭되는 컬럼에 분산
2. **JSON 패키지**: 범용 컬럼(비고/메모 등)에 JSON으로 일괄 저장
3. **수동 지정**: 적절한 컬럼이 없을 때 관리자가 직접 선택

### 🖼️ 12 Template Variations
의약/연구기관 B2B 고급 홍보물 톤의 다양한 디자인 템플릿 로테이션

### 🔒 Security
- API Key/SA JSON은 GitHub Secrets에만 저장
- UI에서 갱신 시 AES-256-GCM으로 암호화 후 내부 시트에 blob 저장
- 복호화 키는 GitHub Secrets에만 존재

---

## 🚀 Quick Start

### 1. Prerequisites
- Node.js 20+
- Google Cloud Service Account
- Gemini API Key
- GitHub Repository

### 2. Setup

```bash
# 의존성 설치
npm install

# 공유 패키지 빌드
npm run build:shared

# Admin UI 실행
npm run dev:ui
```

### 3. Google Cloud Setup

1. [Google Cloud Console](https://console.cloud.google.com) → 새 프로젝트
2. **Google Sheets API** 활성화
3. **Google Drive API** 활성화
4. **IAM → Service Account** 생성 → JSON 키 다운로드
5. Service Account 이메일을 모든 관련 시트 + Drive 폴더에 **편집자**로 공유 초대

### 4. Internal Sheet Setup

Google Sheets에서 새 스프레드시트를 생성하고, 다음 5개 탭을 만드세요:

| 탭 이름 | 헤더 행 (1행에 입력) |
|---------|-------------------|
| `config` | `key`, `value`, `updated_at` |
| `state` | `key`, `value` |
| `run_logs` | `run_id`, `started_at`, `finished_at`, `status`, `rows_processed`, `rows_success`, `rows_failed`, `cycle`, `batch_range`, `error_summary` |
| `row_logs` | `run_id`, `row_index`, `db_row_hash`, `status`, `template_id`, `seed`, `prompt_version`, `poster_url`, `drive_file_id`, `retry_count`, `error_message`, `created_at` |
| `errors` | `error_id`, `run_id`, `row_index`, `error_type`, `error_message`, `stack_trace`, `created_at` |

`state` 탭에 초기값 입력:

| key | value |
|-----|-------|
| `next_row_index` | `1` |
| `cycle_number` | `1` |
| `last_run_at` | |
| `is_running` | `false` |
| `lock_expiry` | |
| `total_generated` | `0` |

### 5. GitHub Secrets

Repository Settings → Secrets → Actions:

| Secret Name | 값 |
|-------------|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Service Account JSON 전체 |
| `ENCRYPTION_KEY` | 64자 hex 문자열 (`openssl rand -hex 32`) |
| `INTERNAL_SHEET_ID` | 내부 시트의 Spreadsheet ID |

### 6. Admin UI Config

1. Admin UI 실행 후 **연결 설정**에서 DB 시트, 결과 시트, Drive 폴더 ID 입력
2. **헤더 매핑**에서 DB/결과 시트 헤더 추론 + 확정
3. **고정 문구** 설정
4. **스케줄** 설정

### 7. First Run

```bash
# GitHub Actions에서 수동 실행
# Repository → Actions → Poster Auto-Generation Worker → Run workflow
```

---

## 📋 Operational Checklist

### 초기 설정
- [ ] Google Cloud 프로젝트 생성 + API 활성화
- [ ] Service Account 생성 + JSON 키 다운로드
- [ ] 내부 시트 생성 + 5개 탭 + 초기값 입력
- [ ] DB 시트, 결과 시트, 내부 시트에 SA 이메일 편집자 공유
- [ ] Drive 폴더 생성 + SA 이메일 편집자 공유
- [ ] GitHub Secrets 3개 설정
- [ ] Admin UI에서 연결/매핑/문구/스케줄 설정
- [ ] workflow_dispatch로 첫 실행 테스트

### 일상 운영
- [ ] Admin UI 대시보드에서 생성 현황 확인
- [ ] 에러 발생 시 로그 탭에서 상세 확인
- [ ] DB 시트 헤더 변경 시 → 매핑 페이지에서 재설정
- [ ] API Key 만료/변경 시 → 연결 설정에서 갱신

### 장애 대응
- [ ] 워커 실행 안 됨 → GitHub Actions 로그 확인
- [ ] 시트 접근 불가 → SA 이메일 공유 상태 확인
- [ ] 포스터 생성 실패 → Gemini API quota/key 확인
- [ ] 락 해제 안 됨 → 내부 시트 state 탭에서 `is_running`을 `false`로 수동 변경

---

## 📄 License

Private — 한양맞춤의약연구센터 내부 사용
