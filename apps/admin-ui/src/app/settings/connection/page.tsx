'use client';

import { useEffect, useState } from 'react';

export default function ConnectionSettingsPage() {
    const [config, setConfig] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');

    useEffect(() => {
        fetchConfig();
    }, []);

    async function fetchConfig() {
        try {
            const res = await fetch('/api/config');
            setConfig(await res.json());
        } catch {
            setMessage('설정을 불러오지 못했습니다.');
        } finally {
            setLoading(false);
        }
    }

    async function saveField(key: string, value: string) {
        setSaving(true);
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value }),
            });
            setConfig((prev) => ({ ...prev, [key]: value }));
            setMessage(`✅ ${key} 저장 완료`);
            setTimeout(() => setMessage(''), 3000);
        } catch {
            setMessage('❌ 저장 실패');
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return <div style={{ textAlign: 'center', padding: '60px' }}><div className="spinner" /></div>;
    }

    return (
        <>
            <div className="page-header">
                <h2>🔗 연결 설정</h2>
                <p>Google Sheets 및 Drive 연결 정보를 관리합니다</p>
            </div>

            {message && <div className="alert alert-success">{message}</div>}

            <div className="grid-2">
                {/* DB 시트 */}
                <div className="card">
                    <h3 className="card-title">📥 DB 시트 (입력)</h3>
                    <div className="form-group">
                        <label className="form-label">Spreadsheet ID</label>
                        <input
                            className="form-input"
                            value={config.db_spreadsheet_id || ''}
                            onChange={(e) => setConfig({ ...config, db_spreadsheet_id: e.target.value })}
                            placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                        />
                        <p className="form-hint">URL에서 /d/ 뒤의 긴 문자열</p>
                    </div>
                    <div className="form-group">
                        <label className="form-label">시트 탭명</label>
                        <input
                            className="form-input"
                            value={config.db_sheet_name || ''}
                            onChange={(e) => setConfig({ ...config, db_sheet_name: e.target.value })}
                            placeholder="Sheet1"
                        />
                    </div>
                    <button
                        className="btn btn-primary"
                        disabled={saving}
                        onClick={async () => {
                            await saveField('db_spreadsheet_id', config.db_spreadsheet_id || '');
                            await saveField('db_sheet_name', config.db_sheet_name || '');
                        }}
                    >
                        {saving ? <span className="spinner" /> : '💾'} 저장
                    </button>
                </div>

                {/* 결과 시트 */}
                <div className="card">
                    <h3 className="card-title">📤 결과 시트 (출력)</h3>
                    <div className="form-group">
                        <label className="form-label">Spreadsheet ID</label>
                        <input
                            className="form-input"
                            value={config.result_spreadsheet_id || ''}
                            onChange={(e) => setConfig({ ...config, result_spreadsheet_id: e.target.value })}
                            placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                        />
                    </div>
                    <div className="form-group">
                        <label className="form-label">시트 탭명</label>
                        <input
                            className="form-input"
                            value={config.result_sheet_name || ''}
                            onChange={(e) => setConfig({ ...config, result_sheet_name: e.target.value })}
                            placeholder="결과"
                        />
                    </div>
                    <button
                        className="btn btn-primary"
                        disabled={saving}
                        onClick={async () => {
                            await saveField('result_spreadsheet_id', config.result_spreadsheet_id || '');
                            await saveField('result_sheet_name', config.result_sheet_name || '');
                        }}
                    >
                        {saving ? <span className="spinner" /> : '💾'} 저장
                    </button>
                </div>
            </div>

            {/* Drive 설정 */}
            <div className="card">
                <h3 className="card-title">📁 Google Drive</h3>
                <div className="form-group">
                    <label className="form-label">Drive 폴더 ID</label>
                    <input
                        className="form-input"
                        value={config.drive_folder_id || ''}
                        onChange={(e) => setConfig({ ...config, drive_folder_id: e.target.value })}
                        placeholder="1ABC_xyz123..."
                    />
                    <p className="form-hint">
                        포스터 이미지가 저장될 폴더. URL에서 folders/ 뒤의 ID를 입력하세요.
                    </p>
                </div>
                <button
                    className="btn btn-primary"
                    disabled={saving}
                    onClick={() => saveField('drive_folder_id', config.drive_folder_id || '')}
                >
                    💾 저장
                </button>
            </div>

            {/* API Key */}
            <div className="card">
                <h3 className="card-title">🔑 Gemini API Key</h3>
                <div className="alert alert-warning">
                    ⚠️ API Key는 AES-GCM으로 암호화 후 저장됩니다. 복호화 키는 GitHub Secrets에 보관하세요.
                </div>
                <div className="form-group">
                    <label className="form-label">API Key</label>
                    <input
                        className="form-input"
                        type="password"
                        placeholder="AIza..."
                        id="gemini-key-input"
                    />
                    <p className="form-hint">
                        입력 후 저장하면 암호화되어 내부 시트에 저장됩니다.
                    </p>
                </div>
                <button
                    className="btn btn-primary"
                    disabled={saving}
                    onClick={() => {
                        const input = document.getElementById('gemini-key-input') as HTMLInputElement;
                        if (input.value) {
                            saveField('gemini_api_key_encrypted', input.value);
                        }
                    }}
                >
                    🔐 암호화 & 저장
                </button>
            </div>

            {/* Service Account 가이드 */}
            <div className="card">
                <h3 className="card-title">🤖 Service Account 설정 가이드</h3>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: '14px', lineHeight: '1.8' }}>
                    <ol>
                        <li>Google Cloud Console → IAM → Service Account 생성</li>
                        <li>JSON 키 다운로드</li>
                        <li>GitHub Repository → Settings → Secrets → <code>GOOGLE_SERVICE_ACCOUNT_KEY</code>에 JSON 전체 붙여넣기</li>
                        <li>Service Account 이메일을 DB/결과/내부 시트 + Drive 폴더에 편집자로 공유</li>
                        <li>셋업 후 <code>ENCRYPTION_KEY</code>와 <code>INTERNAL_SHEET_ID</code>도 Secrets에 추가</li>
                    </ol>
                </div>
            </div>
        </>
    );
}
