'use client';

import { useEffect, useState } from 'react';

interface DashboardData {
    totalGenerated: number;
    cycleNumber: number;
    nextRowIndex: number;
    lastRunAt: string;
    isRunning: boolean;
    recentRuns: {
        runId: string;
        startedAt: string;
        finishedAt: string;
        status: string;
        rowsProcessed: number;
        rowsSuccess: number;
        rowsFailed: number;
        cycle: number;
        batchRange: string;
        errorSummary: string;
    }[];
    rowGenerationCounts: Record<number, number>;
}

export default function DashboardPage() {
    const [data, setData] = useState<DashboardData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        fetchData();
    }, []);

    async function fetchData() {
        try {
            const res = await fetch('/api/dashboard');
            if (!res.ok) throw new Error('Failed to load dashboard');
            setData(await res.json());
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Error');
        } finally {
            setLoading(false);
        }
    }

    if (loading) return <div className="page-header"><div className="spinner" /></div>;
    if (error) return <div className="alert alert-danger">⚠️ {error}</div>;
    if (!data) return null;

    const genCountEntries = Object.entries(data.rowGenerationCounts)
        .map(([k, v]) => ({ row: parseInt(k), count: v }))
        .sort((a, b) => a.row - b.row);

    return (
        <>
            <div className="page-header">
                <h2>📊 대시보드</h2>
                <p>포스터 자동 생성 시스템 현황</p>
            </div>

            {data.isRunning && (
                <div className="alert alert-warning">
                    🔄 현재 워커가 실행 중입니다...
                </div>
            )}

            <div className="stats-grid">
                <div className="stat-card">
                    <div className="stat-icon">🖼️</div>
                    <div className="stat-value">{data.totalGenerated}</div>
                    <div className="stat-label">총 생성 수</div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon">🔄</div>
                    <div className="stat-value">{data.cycleNumber}</div>
                    <div className="stat-label">현재 Cycle</div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon">📍</div>
                    <div className="stat-value">{data.nextRowIndex}</div>
                    <div className="stat-label">다음 처리 행</div>
                </div>
                <div className="stat-card">
                    <div className="stat-icon">🕐</div>
                    <div className="stat-value" style={{ fontSize: '16px' }}>
                        {data.lastRunAt ? new Date(data.lastRunAt).toLocaleString('ko-KR') : '없음'}
                    </div>
                    <div className="stat-label">마지막 실행</div>
                </div>
            </div>

            {/* 최근 실행 */}
            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">📋 최근 실행 이력</h3>
                    <button className="btn btn-outline" onClick={fetchData}>새로고침</button>
                </div>
                <div className="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>시작</th>
                                <th>상태</th>
                                <th>배치</th>
                                <th>성공</th>
                                <th>실패</th>
                                <th>Cycle</th>
                                <th>에러</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.recentRuns.length === 0 ? (
                                <tr>
                                    <td colSpan={7} style={{ textAlign: 'center', padding: '32px' }}>
                                        실행 이력이 없습니다
                                    </td>
                                </tr>
                            ) : (
                                data.recentRuns.map((run) => (
                                    <tr key={run.runId}>
                                        <td>{new Date(run.startedAt).toLocaleString('ko-KR')}</td>
                                        <td>
                                            <span className={`badge badge-${run.status === 'success' ? 'success' : run.status === 'partial' ? 'warning' : 'danger'}`}>
                                                {run.status}
                                            </span>
                                        </td>
                                        <td>{run.batchRange}</td>
                                        <td style={{ color: 'var(--color-success)' }}>{run.rowsSuccess}</td>
                                        <td style={{ color: run.rowsFailed > 0 ? 'var(--color-danger)' : 'inherit' }}>
                                            {run.rowsFailed}
                                        </td>
                                        <td>{run.cycle}</td>
                                        <td style={{ maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {run.errorSummary || '-'}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* 행별 생성 횟수 */}
            <div className="card">
                <div className="card-header">
                    <h3 className="card-title">📈 행별 생성 횟수</h3>
                </div>
                <div className="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th>행 번호</th>
                                <th>생성 횟수</th>
                                <th>진행 바</th>
                            </tr>
                        </thead>
                        <tbody>
                            {genCountEntries.length === 0 ? (
                                <tr>
                                    <td colSpan={3} style={{ textAlign: 'center', padding: '32px' }}>
                                        아직 생성된 데이터가 없습니다
                                    </td>
                                </tr>
                            ) : (
                                genCountEntries.slice(0, 50).map(({ row, count }) => (
                                    <tr key={row}>
                                        <td>#{row}</td>
                                        <td>{count}회</td>
                                        <td>
                                            <div style={{
                                                width: '100%',
                                                height: '8px',
                                                background: 'var(--color-bg-input)',
                                                borderRadius: '4px',
                                                overflow: 'hidden'
                                            }}>
                                                <div style={{
                                                    width: `${Math.min(count * 20, 100)}%`,
                                                    height: '100%',
                                                    background: 'linear-gradient(90deg, var(--color-primary), var(--color-accent))',
                                                    borderRadius: '4px',
                                                    transition: 'width 0.3s'
                                                }} />
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </>
    );
}
