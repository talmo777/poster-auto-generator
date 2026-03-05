import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: '포스터 자동생성 관리자',
    description: '한양맞춤의약연구센터 포스터 자동 생성 시스템 관리 대시보드',
};

const navItems = [
    { section: '모니터링' },
    { href: '/', label: '대시보드', icon: '📊' },
    { href: '/logs', label: '로그/에러', icon: '📋' },
    { section: '설정' },
    { href: '/settings/connection', label: '연결 설정', icon: '🔗' },
    { href: '/settings/schedule', label: '스케줄', icon: '⏰' },
    { href: '/settings/mapping', label: '헤더 매핑', icon: '🗂️' },
    { href: '/settings/message', label: '고정 문구', icon: '✏️' },
];

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="ko">
            <head>
                <link
                    href="https://fonts.googleapis.com/css2?family=Pretendard:wght@300;400;500;600;700;800&display=swap"
                    rel="stylesheet"
                />
            </head>
            <body>
                <div className="app-container">
                    <aside className="sidebar">
                        <div className="sidebar-brand">
                            <h1>🖼️ Poster Generator</h1>
                            <p>한양맞춤의약연구센터</p>
                        </div>
                        <nav>
                            <ul className="sidebar-nav">
                                {navItems.map((item, i) => {
                                    if ('section' in item && !('href' in item)) {
                                        return (
                                            <li key={i} className="sidebar-section-title">
                                                {item.section}
                                            </li>
                                        );
                                    }
                                    if ('href' in item) {
                                        return (
                                            <li key={i}>
                                                <a href={item.href}>
                                                    <span className="nav-icon">{item.icon}</span>
                                                    {item.label}
                                                </a>
                                            </li>
                                        );
                                    }
                                    return null;
                                })}
                            </ul>
                        </nav>
                    </aside>
                    <main className="main-content">{children}</main>
                </div>
            </body>
        </html>
    );
}
