import { usePathname } from './lib/router';
import { CatalogPage } from './pages/CatalogPage';
import { HeroPage } from './pages/HeroPage';
import { JudgePage } from './pages/JudgePage';
import { NotFoundPage } from './pages/NotFoundPage';

export function App() {
  const path = usePathname();
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/') return <CatalogPage />;
  if (clean === '/gate') return <HeroPage />;
  if (clean === '/judge') return <JudgePage />;
  return <NotFoundPage path={clean} />;
}
