'use client';

import { useEffect, useState } from 'react';

type LogTab = 'runs' | 'rows' | 'errors';

export default function LogsPage() {
    const [tab, setTab] = useState<LogTab>('runs');
    const [data, setData] = useState<unknown[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    useEffect(() => {
        fetchLogs();
    }, [tab]);

    async function fetchLogs() {
        setLoading(true);
        try {
            const res = await fetch(`/api/logs/${tab}`);
            setData(await res.json());
        } catch {
            setData([]);
        } finally {
            setLoading(false);
        }
    }

    const filtered = (data as Record<string, unknown>[]).filter((item) =>
        JSON.stringify(item).toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <>
            <div className="page-header">
                <h2>📋 로그 & 에러</h2>
                <p>실행 이력, 행 단위 기록, 에러 로그를 확인합니다</p>
            </div>

            <div className="tabs">
                {(['runs', 'rows', 'errors'] as LogTab[]).map((t) => (
                    <button
                        key={t}
                        className={`tab ${tab === t ? 'active' : ''}`}
                        onClick={() => setTab(t)}
                    >
                        {t === 'runs' ? '🏃 실행 로그' : t === 'rows' ? '📄 행 로그' : '⚠️ 에러'}
                    </button>
                ))}
            </div>

            <div className="card">
                <div className="card-header">
                    <input
                        type="text"
                        className="form-input"
                        placeholder="검색..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{ maxWidth: '300px' }}
                    />
                    <button className="btn btn-outline" onClick={fetchLogs}>새로고침</button>
                </div>

                {loading ? (
                    <div style={{ textAlign: 'center', padding: '40px' }}><div className="spinner" /></div>
                ) : (
                    <div className="table-container">
                        {tab === 'runs' && <RunsTable data={filtered} />}
                        {tab === 'rows' && <RowsTable data={filtered} />}
                        {tab === 'errors' && <ErrorsTable data={filtered} />}
                    </div>
                )}
            </div>
        </>
    );
}

function RunsTable({ data }: { data: Record<string, unknown>[] }) {
    return (
        <table>
            <thead>
                <tr>
                    <th>Run ID</th>
                    <th>시작</th>
                    <th>종료</th>
                    <th>상태</th>
                    <th>처리</th>
                    <th>성공</th>
                    <th>실패</th>
                    <th>배치</th>
                    <th>에러</th>
                </tr>
            </thead>
            <tbody>
                {data.length === 0 ? (
                    <tr><td colSpan={9} style={{ textAlign: 'center', padding: '32px' }}>데이터 없음</td></tr>
                ) : data.map((r, i) => (
                    <tr key={i}>
                        <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{String(r.runId).slice(0, 12)}...</td>
                        <td>{r.startedAt ? new Date(String(r.startedAt)).toLocaleString('ko-KR') : '-'}</td>
                        <td>{r.finishedAt ? new Date(String(r.finishedAt)).toLocaleString('ko-KR') : '-'}</td>
                        <td>
                            <span className={`badge badge-${r.status === 'success' ? 'success' : r.status === 'partial' ? 'warning' : 'danger'}`}>
                                {String(r.status)}
                            </span>
                        </td>
                        <td>{String(r.rowsProcessed)}</td>
                        <td>{String(r.rowsSuccess)}</td>
                        <td>{String(r.rowsFailed)}</td>
                        <td>{String(r.batchRange)}</td>
                        <td style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(r.errorSummary || '-')}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function RowsTable({ data }: { data: Record<string, unknown>[] }) {
    return (
        <table>
            <thead>
                <tr>
                    <th>행</th>
                    <th>상태</th>
                    <th>템플릿</th>
                    <th>시드</th>
                    <th>포스터 URL</th>
                    <th>재시도</th>
                    <th>에러</th>
                    <th>생성일</th>
                </tr>
            </thead>
            <tbody>
                {data.length === 0 ? (
                    <tr><td colSpan={8} style={{ textAlign: 'center', padding: '32px' }}>데이터 없음</td></tr>
                ) : data.map((r, i) => (
                    <tr key={i}>
                        <td>#{String(r.rowIndex)}</td>
                        <td>
                            <span className={`badge badge-${r.status === 'success' ? 'success' : r.status === 'skipped' ? 'info' : 'danger'}`}>
                                {String(r.status)}
                            </span>
                        </td>
                        <td>{String(r.templateId || '-')}</td>
                        <td style={{ fontFamily: 'monospace' }}>{String(r.seed || '-')}</td>
                        <td>
                            {r.posterUrl ? (
                                <a href={String(r.posterUrl)} target="_blank" rel="noreferrer">🔗 보기</a>
                            ) : '-'}
                        </td>
                        <td>{String(r.retryCount)}</td>
                        <td style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(r.errorMessage || '-')}</td>
                        <td>{r.createdAt ? new Date(String(r.createdAt)).toLocaleString('ko-KR') : '-'}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ErrorsTable({ data }: { data: Record<string, unknown>[] }) {
    return (
        <table>
            <thead>
                <tr>
                    <th>에러 ID</th>
                    <th>Run ID</th>
                    <th>행</th>
                    <th>타입</th>
                    <th>메시지</th>
                    <th>발생일</th>
                </tr>
            </thead>
            <tbody>
                {data.length === 0 ? (
                    <tr><td colSpan={6} style={{ textAlign: 'center', padding: '32px' }}>에러 없음 🎉</td></tr>
                ) : data.map((r, i) => (
                    <tr key={i}>
                        <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{String(r.errorId).slice(0, 8)}...</td>
                        <td style={{ fontFamily: 'monospace', fontSize: '11px' }}>{String(r.runId).slice(0, 8)}...</td>
                        <td>#{String(r.rowIndex)}</td>
                        <td><span className="badge badge-danger">{String(r.errorType)}</span></td>
                        <td style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{String(r.errorMessage)}</td>
                        <td>{r.createdAt ? new Date(String(r.createdAt)).toLocaleString('ko-KR') : '-'}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
