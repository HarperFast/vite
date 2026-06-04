import { App } from '@/App.tsx';
import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';

import './style.css';

// Hydrate the server-rendered markup. In SPA-only setups you would use `createRoot(...).render(...)`
// instead, but because this app is server-rendered we hydrate the existing DOM.
hydrateRoot(
	document.getElementById('app')!,
	<StrictMode>
		<App />
	</StrictMode>
);
