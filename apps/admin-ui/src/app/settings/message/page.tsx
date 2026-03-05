'use client';

import { useEffect, useState } from 'react';

export default function MessageSettingsPage() {
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState('');

    useEffect(() => {
        fetchMessage();
    }, []);

    async function fetchMessage() {
        try {
            const res = await fetch('/api/config');
            const config = await res.json();
            setMessage(config.fixed_message || '');
        } catch {
            setStatus('설정을 불러오지 못했습니다.');
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
                body: JSON.stringify({ key: 'fixed_message', value: message }),
            });
            setStatus('✅ 고정 문구 저장 완료');
            setTimeout(() => setStatus(''), 3000);
        } catch {
            setStatus('❌ 저장 실패');
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
                <h2>✏️ 고정 문구</h2>
                <p>모든 포스터에 공통으로 들어가는 브랜드/센터 메시지를 설정합니다</p>
            </div>

            {status && <div className="alert alert-success">{status}</div>}

            <div className="card">
                <h3 className="card-title">📝 브랜드 메시지</h3>
                <div className="form-group">
                    <label className="form-label">고정 문구</label>
                    <textarea
                        className="form-textarea"
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        placeholder="예: 한양맞춤의약연구센터 - 첨단 연구장비 공동활용 서비스&#10;최고 수준의 분석 장비와 전문 인력이 함께합니다."
                        style={{ minHeight: '160px' }}
                    />
                    <p className="form-hint">
                        이 문구는 모든 포스터 생성 시 LLM 프롬프트에 포함됩니다.
                        수정 전까지 계속 적용됩니다.
                    </p>
                </div>
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                    {saving ? <span className="spinner" /> : '💾'} 저장
                </button>
            </div>

            {/* 미리보기 */}
            <div className="card">
                <h3 className="card-title">👁️ 포스터 적용 미리보기</h3>
                <div style={{
                    background: 'linear-gradient(135deg, #1B2A4A, #2E4C7D)',
                    borderRadius: 'var(--radius)',
                    padding: '40px',
                    color: 'white',
                    textAlign: 'center',
                    position: 'relative',
                    overflow: 'hidden',
                }}>
                    <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        background: 'radial-gradient(circle at 30% 30%, rgba(78, 205, 196, 0.1), transparent 60%)',
                    }} />
                    <div style={{ position: 'relative', zIndex: 1 }}>
                        <div style={{ fontSize: '11px', letterSpacing: '3px', textTransform: 'uppercase', color: '#4ECDC4', marginBottom: '16px' }}>
                            한양맞춤의약연구센터
                        </div>
                        <h3 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '12px', lineHeight: 1.4 }}>
                            첨단 연구장비명이 여기에 표시
                        </h3>
                        <p style={{ fontSize: '13px', color: 'rgba(255,255,255,0.7)', marginBottom: '24px', lineHeight: 1.6 }}>
                            장비 설명이 여기에 표시됩니다
                        </p>
                        <div style={{
                            background: 'rgba(255,255,255,0.1)',
                            borderRadius: '8px',
                            padding: '16px',
                            margin: '0 auto',
                            maxWidth: '400px',
                            border: '1px solid rgba(78, 205, 196, 0.3)',
                        }}>
                            <p style={{ fontSize: '12px', color: '#4ECDC4', fontStyle: 'italic', whiteSpace: 'pre-line' }}>
                                {message || '(고정 문구가 여기에 표시됩니다)'}
                            </p>
                        </div>
                        <div style={{ marginTop: '20px' }}>
                            <span style={{
                                display: 'inline-block',
                                padding: '8px 24px',
                                background: '#4ECDC4',
                                color: '#1B2A4A',
                                borderRadius: '20px',
                                fontSize: '13px',
                                fontWeight: 600,
                            }}>
                                문의하기 →
                            </span>
                        </div>
                    </div>
                </div>
                <p className="form-hint" style={{ marginTop: '12px' }}>
                    * 실제 포스터는 LLM이 데이터 기반으로 동적 생성합니다. 위는 고정 문구 위치 예시입니다.
                </p>
            </div>
        </>
    );
}
