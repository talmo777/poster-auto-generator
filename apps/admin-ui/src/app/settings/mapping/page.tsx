'use client';

import { useEffect, useState } from 'react';

interface MappingItem {
    headerName: string;
    columnIndex: number;
    inferredSlot: string;
    confidence: number;
    confirmedSlot?: string;
    isConfirmed: boolean;
}

const DB_SLOTS = [
    'headline_source', 'equipment_name', 'description', 'price_info',
    'contact', 'keywords', 'reference_image_url', 'location',
    'availability', 'category', 'specification', 'manufacturer',
    'model_number', 'booking_link', 'unmapped',
];

const RESULT_SLOTS = [
    'poster_url', 'headline_used', 'summary', 'generation_date',
    'template_id', 'json_package', 'unmapped',
];

type MappingTab = 'db' | 'result';

export default function MappingPage() {
    const [tab, setTab] = useState<MappingTab>('db');
    const [config, setConfig] = useState<Record<string, string>>({});
    const [headers, setHeaders] = useState<string[]>([]);
    const [mappings, setMappings] = useState<MappingItem[]>([]);
    const [resultStrategy, setResultStrategy] = useState('distributed');
    const [loading, setLoading] = useState(true);
    const [inferring, setInferring] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [needsRemapping, setNeedsRemapping] = useState(false);

    useEffect(() => {
        fetchConfig();
    }, []);

    async function fetchConfig() {
        try {
            const res = await fetch('/api/config');
            const c = await res.json();
            setConfig(c);
            setNeedsRemapping(c.header_remapping_needed === 'true');

            // 기존 매핑 로드
            if (tab === 'db' && c.db_header_mapping_json) {
                try { setMappings(JSON.parse(c.db_header_mapping_json)); } catch { }
            } else if (tab === 'result' && c.result_header_mapping_json) {
                try {
                    const parsed = JSON.parse(c.result_header_mapping_json);
                    setMappings(parsed.mappings || []);
                    setResultStrategy(parsed.strategy || 'distributed');
                } catch { }
            }
        } catch { } finally {
            setLoading(false);
        }
    }

    async function loadHeaders() {
        const sheetId = tab === 'db' ? config.db_spreadsheet_id : config.result_spreadsheet_id;
        const sheetName = tab === 'db' ? config.db_sheet_name : config.result_sheet_name;
        if (!sheetId || !sheetName) {
            setMessage('⚠️ 먼저 연결 설정에서 시트 정보를 입력하세요.');
            return;
        }
        try {
            const res = await fetch(`/api/headers?spreadsheetId=${encodeURIComponent(sheetId)}&sheetName=${encodeURIComponent(sheetName)}`);
            const h = await res.json();
            setHeaders(h);
            setMessage(`✅ ${h.length}개 헤더를 읽어왔습니다.`);
        } catch {
            setMessage('❌ 헤더 읽기 실패');
        }
    }

    async function runInference() {
        if (headers.length === 0) {
            setMessage('⚠️ 먼저 헤더를 불러오세요.');
            return;
        }
        setInferring(true);
        try {
            const res = await fetch('/api/infer-mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ headers, type: tab }),
            });
            const result = await res.json();
            if (!res.ok) {
                setMessage(`❌ 추론 실패: ${result.error || res.statusText}`);
                return;
            }
            if (tab === 'db') {
                setMappings((result as MappingItem[]).map(m => ({ ...m, isConfirmed: false })));
            } else {
                setMappings((result.mappings as MappingItem[]).map(m => ({ ...m, isConfirmed: false })));
                setResultStrategy(result.strategy || 'distributed');
            }
            setMessage('✅ LLM 추론 완료! 아래에서 확인/수정 후 확정하세요.');
        } catch {
            setMessage('❌ 추론 실패');
        } finally {
            setInferring(false);
        }
    }

    async function saveMappings() {
        setSaving(true);
        const confirmed = mappings.map(m => ({
            ...m,
            confirmedSlot: m.confirmedSlot || m.inferredSlot,
            isConfirmed: true,
        }));
        try {
            if (tab === 'db') {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'db_header_mapping_json', value: JSON.stringify(confirmed) }),
                });
                // 해시 저장
                const hashRes = await fetch(`/api/headers?spreadsheetId=${encodeURIComponent(config.db_spreadsheet_id)}&sheetName=${encodeURIComponent(config.db_sheet_name)}`);
                const currentHeaders = await hashRes.json();
                const hash = await computeHash(currentHeaders);
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'db_header_hash', value: hash }),
                });
            } else {
                const mappingConfig = {
                    strategy: resultStrategy,
                    mappings: confirmed,
                    jsonPackageColumn: resultStrategy === 'json_package'
                        ? confirmed.find(m => (m.confirmedSlot || m.inferredSlot) === 'json_package')?.headerName
                        : undefined,
                };
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'result_header_mapping_json', value: JSON.stringify(mappingConfig) }),
                });
                const hashRes = await fetch(`/api/headers?spreadsheetId=${encodeURIComponent(config.result_spreadsheet_id)}&sheetName=${encodeURIComponent(config.result_sheet_name)}`);
                const currentHeaders = await hashRes.json();
                const hash = await computeHash(currentHeaders);
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: 'result_header_hash', value: hash }),
                });
            }
            // 재매핑 필요 상태 해제
            await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: 'header_remapping_needed', value: 'false' }),
            });
            setNeedsRemapping(false);
            setMessage('✅ 매핑 확정 완료!');
        } catch {
            setMessage('❌ 저장 실패');
        } finally {
            setSaving(false);
        }
    }

    function updateSlot(index: number, slot: string) {
        setMappings(prev => {
            const next = [...prev];
            next[index] = { ...next[index], confirmedSlot: slot };
            return next;
        });
    }

    const slots = tab === 'db' ? DB_SLOTS : RESULT_SLOTS;

    if (loading) {
        return <div style={{ textAlign: 'center', padding: '60px' }}><div className="spinner" /></div>;
    }

    return (
        <>
            <div className="page-header">
                <h2>🗂️ 헤더 매핑</h2>
                <p>시트 헤더의 의미를 LLM으로 추론하고 관리자가 확정합니다</p>
            </div>

            {needsRemapping && (
                <div className="alert alert-danger">
                    🚨 시트 헤더가 변경되었습니다! 헤더를 다시 불러오고 매핑을 재설정하세요.
                </div>
            )}
            {message && <div className="alert alert-success">{message}</div>}

            <div className="tabs">
                <button className={`tab ${tab === 'db' ? 'active' : ''}`} onClick={() => { setTab('db'); setMappings([]); setHeaders([]); }}>
                    📥 DB 시트 매핑
                </button>
                <button className={`tab ${tab === 'result' ? 'active' : ''}`} onClick={() => { setTab('result'); setMappings([]); setHeaders([]); }}>
                    📤 결과 시트 매핑
                </button>
            </div>

            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">1️⃣ 현재 헤더 불러오기</h3>
                    <button className="btn btn-outline" onClick={loadHeaders}>
                        📄 헤더 읽기
                    </button>
                </div>
                {headers.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' }}>
                        {headers.map((h, i) => (
                            <span key={i} className="badge badge-info">[{i}] {h}</span>
                        ))}
                    </div>
                )}
            </div>

            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">2️⃣ LLM 추론 실행</h3>
                    <button className="btn btn-primary" onClick={runInference} disabled={inferring || headers.length === 0}>
                        {inferring ? <><span className="spinner" /> 추론 중...</> : '🤖 LLM 추론'}
                    </button>
                </div>
            </div>

            {mappings.length > 0 && (
                <div className="card">
                    <div className="card-header">
                        <h3 className="card-title">3️⃣ 매핑 확인/수정</h3>
                    </div>

                    {tab === 'result' && (
                        <div className="form-group" style={{ marginBottom: '20px' }}>
                            <label className="form-label">저장 전략</label>
                            <select
                                className="form-select"
                                value={resultStrategy}
                                onChange={(e) => setResultStrategy(e.target.value)}
                                style={{ maxWidth: '300px' }}
                            >
                                <option value="distributed">분산 저장 (여러 컬럼에 나눠 저장)</option>
                                <option value="json_package">JSON 패키지 (한 컬럼에 JSON으로 저장)</option>
                                <option value="manual">수동 지정</option>
                            </select>
                        </div>
                    )}

                    {mappings.map((m, i) => (
                        <div key={i} className="mapping-row">
                            <span className="mapping-header-name">
                                [{m.columnIndex}] {m.headerName}
                            </span>
                            <span style={{ fontSize: '20px' }}>→</span>
                            <select
                                className="form-select mapping-slot-select"
                                value={m.confirmedSlot || m.inferredSlot}
                                onChange={(e) => updateSlot(i, e.target.value)}
                            >
                                {slots.map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                ))}
                            </select>
                            <span className={`mapping-confidence ${m.confidence >= 0.8 ? 'confidence-high' : m.confidence >= 0.5 ? 'confidence-medium' : 'confidence-low'}`}>
                                {Math.round(m.confidence * 100)}%
                            </span>
                        </div>
                    ))}

                    <div style={{ marginTop: '24px' }}>
                        <button className="btn btn-success" onClick={saveMappings} disabled={saving}>
                            {saving ? <span className="spinner" /> : '✅'} 매핑 확정
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}

async function computeHash(headers: string[]): Promise<string> {
    const normalized = headers.map(h => h.trim().toLowerCase()).join('|');
    const encoder = new TextEncoder();
    const data = encoder.encode(normalized);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
