import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { base } from 'viem/chains';
import { useDemo } from './useDemo';
import { DemoView } from './DemoView';
import './styles.css';

function App() {
  const model = useDemo();
  return <DemoView model={model} />;
}

const appId = import.meta.env.VITE_PRIVY_APP_ID;
const root = createRoot(document.getElementById('root')!);

root.render(
  appId ? (
    <React.StrictMode>
      <PrivyProvider
        appId={appId}
        clientId={import.meta.env.VITE_PRIVY_CLIENT_ID || undefined}
        config={{
          appearance: { theme: 'dark' },
          embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
          loginMethodsAndOrder: { primary: ['email', 'google'] },
          defaultChain: base,
          supportedChains: [base],
        }}
      >
        <App />
      </PrivyProvider>
    </React.StrictMode>
  ) : (
    <main style={{ color: '#fff', background: '#101010', minHeight: '100vh', padding: 32 }}>
      This demo needs a production Privy app ID. Set VITE_PRIVY_APP_ID before starting it.
    </main>
  ),
);
