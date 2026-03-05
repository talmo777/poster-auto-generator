'use client';

import { useEffect, useState } from 'react';

const PRESETS = [
    { label: '매주 월요일 09:00 KST', cron: '0 0 * * 1', desc: '주 1회' },
    { label: '매주 월/목 09:00 KST', cron: '0 0 * * 1,4', desc: '주 2회' },
    { label: '매주 월/수/금 09:00 KST', cron: '0 0 * * 1,3,5', desc: '주 3회' },
    { label: '매일 09:00 KST', cron: '0 0 * * *', desc: '매일' },
    { label: '매일 09:00, 18:00 KST', cron: '0 0,9 * * *', desc: '하루 2회' },
];

export default function ScheduleSettingsPage() {
    const [batchSize, setBatchSize] = useState(5);
    const [cronExpr, setCronExpr] = useState('0 0 * * 1');
    const [customMode, setCustomMode] = useState(false);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');

    useEffect(() => {
        fetchConfig();
    }, []);

    async function fetchConfig() {
        try {
            const res = await fetch('/api/config');
            const config = await res.json();
            setBatchSize(parseInt(config.batch_size || '5'));
            setCronExpr(config.cron_expression || '0 0 * * 1');
            const isPreset = PRESETS.some((p) => p.cron === (config.cron_expression || '0 0 * * 1'));
            setCustomMode(!isPreset);
        } catch {
            setMessage('설정을 불러오지 못했습니다.');
        } finally {
            setLoading(false);
        }
    }

    async function save() {
        setSaving(true);
        try {
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'batch_size', value: String(batchSize) }),
            });
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'cron_expression', value: cronExpr }),
            });
            setMessage('✅ 스케줄 설정 저장 완료');
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
                <h2>⏰ 스케줄 설정</h2>
                <p>포스터 생성 빈도와 배치 크기를 설정합니다</p>
            </div>

            {message && <div className="alert alert-success">{message}</div>}

            <div className="alert alert-warning">
                ⚠️ 시간대: <strong>Asia/Seoul (KST, UTC+9)</strong> — 아래 시간은 KST 기준입니다.
                GitHub Actions cron은 UTC 기준이므로 내부적으로 변환됩니다.
            </div>

            <div className="grid-2">
                {/* 배치 크기 */}
                <div className="card">
                    <h3 className="card-title">📦 배치 크기</h3>
                    <div className="form-group">
                        <label className="form-label">한 번에 처리할 행 수</label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                            <input
                                type="range"
                                min={1}
                                max={20}
                                value={batchSize}
                                onChange={(e) => setBatchSize(parseInt(e.target.value))}
                                style={{ flex: 1 }}
                            />
                            <input
                                className="form-input"
                                type="number"
                                min={1}
                                max={100}
                                value={batchSize}
                                onChange={(e) => setBatchSize(parseInt(e.target.value) || 1)}
                                style={{ width: '80px' }}
                            />
                        </div>
                        <p className="form-hint">
                            1회 실행 시 {batchSize}개 행을 처리합니다.
                            GitHub Actions 무료 한도를 고려해 5~10 권장.
                        </p>
                    </div>
                </div>

                {/* 실행 빈도 */}
                <div className="card">
                    <h3 className="card-title">📅 실행 빈도</h3>

                    {!customMode ? (
                        <div className="form-group">
                            <label className="form-label">프리셋 선택</label>
                            {PRESETS.map((preset) => (
                                <label
                                    key={preset.cron}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '12px',
                                        padding: '10px 14px',
                                        borderRadius: '8px',
                                        marginBottom: '6px',
                                        cursor: 'pointer',
                                        background: cronExpr === preset.cron ? 'rgba(108,99,255,0.1)' : 'transparent',
                                        border: `1px solid ${cronExpr === preset.cron ? 'var(--color-primary)' : 'transparent'}`,
                                        transition: 'all 0.2s',
                                    }}
                                >
                                    <input
                                        type="radio"
                                        name="preset"
                                        checked={cronExpr === preset.cron}
                                        onChange={() => setCronExpr(preset.cron)}
                                    />
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: '14px' }}>{preset.label}</div>
                                        <div style={{ fontSize: '12px', color: 'var(--color-text-muted)' }}>{preset.desc}</div>
                                    </div>
                                </label>
                            ))}
                            <button
                                className="btn btn-outline"
                                style={{ marginTop: '12px' }}
                                onClick={() => setCustomMode(true)}
                            >
                                🛠️ 고급: Cron 직접 입력
                            </button>
                        </div>
                    ) : (
                        <div className="form-group">
                            <label className="form-label">Cron 표현식 (UTC 기준)</label>
                            <input
                                className="form-input"
                                value={cronExpr}
                                onChange={(e) => setCronExpr(e.target.value)}
                                placeholder="0 0 * * 1"
                                style={{ fontFamily: 'monospace' }}
                            />
                            <p className="form-hint">
                                형식: 분 시 일 월 요일 (UTC). 예: &quot;0 0 * * 1&quot; = 매주 월요일 UTC 00:00
                            </p>
                            <button
                                className="btn btn-outline"
                                style={{ marginTop: '8px' }}
                                onClick={() => setCustomMode(false)}
                            >
                                ← 프리셋으로 돌아가기
                            </button>
                        </div>
                    )}
                </div>
            </div>

            <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? <span className="spinner" /> : '💾'} 스케줄 저장
            </button>
        </>
    );
}
