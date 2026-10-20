import { useEffect, useState } from 'react';
import { useTuringWallet } from 'turing-wallet-provider';
import { logAction } from './actionLog';

export default function useWalletSession() {
  const wallet = useTuringWallet();
  const [address, setAddress] = useState('');
  const [network, setNetwork] = useState(null);
  const [walletInfo, setWalletInfo] = useState(null);
  const [status, setStatus] = useState('Connect Turing Wallet to get started.');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const networkIsDevnet = network?.network === 'tbc' && network?.type === 'testnet';

  useEffect(() => {
    let active = true;
    const refreshWalletDetails = async (networkOverride) => {
      if (!wallet.isReady) return false;
      try {
        const [walletAddresses, currentNetwork, info] = await Promise.all([
          wallet.getAddress(),
          wallet.getNetwork(),
          wallet.getInfo(),
        ]);
        console.log("Wallet: ", wallet);
        if (!active) return false;
        setAddress(walletAddresses?.tbcAddress ?? walletAddresses?.addresses?.tbcAddress ?? '');
        setNetwork(networkOverride ?? currentNetwork ?? null);
        setWalletInfo(info ?? null);
        return true;
      } catch {
        return false;
      }
    };
    const onNetworkChanged = (event) => {
      void refreshWalletDetails(event.detail?.network);
    };
    const onAccountChanged = () => {
      void refreshWalletDetails();
    };
    const onVisibilityChanged = () => {
      if (document.visibilityState === 'visible' && address) void refreshWalletDetails();
    };

    let readinessPoll;
    window.addEventListener('TuringNetworkChanged', onNetworkChanged);
    window.addEventListener('TuringAccountChanged', onAccountChanged);
    document.addEventListener('visibilitychange', onVisibilityChanged);
    if (wallet.isReady) {
      void refreshWalletDetails();
    } else {
      readinessPoll = window.setInterval(async () => {
        if (await refreshWalletDetails()) window.clearInterval(readinessPoll);
      }, 500);
    }
    return () => {
      active = false;
      if (readinessPoll) window.clearInterval(readinessPoll);
      window.removeEventListener('TuringNetworkChanged', onNetworkChanged);
      window.removeEventListener('TuringAccountChanged', onAccountChanged);
      document.removeEventListener('visibilitychange', onVisibilityChanged);
    };
  }, [wallet, address]);

  async function connect() {
    let logData;
    const recordStatus = (message) => {
      setStatus(message);
      if (logData === undefined) logData = { status: message };
    };
    try {
      setResult(null);
      setAddress('');
      setNetwork(null);
      setWalletInfo(null);
      if (!wallet.isReady) {
        recordStatus('Turing Wallet was not detected. Open this URL inside the Turing Wallet mobile DApp browser, not Safari or Chrome.');
        return;
      }

      setBusy(true);
      try {
        const connectResult = await wallet.connect();
        logData = { response: connectResult };
        const [walletAddresses, currentNetwork, info] = await Promise.all([
          wallet.getAddress(),
          wallet.getNetwork(),
          wallet.getInfo(),
        ]);
        logData = { response: connectResult, addresses: walletAddresses, network: currentNetwork, info };
        const connectedAddress = walletAddresses?.tbcAddress
          ?? connectResult?.tbcAddress
          ?? connectResult?.addresses?.tbcAddress
          ?? '';
        setWalletInfo(info ?? null);
        if (!connectedAddress) {
          setNetwork(currentNetwork);
          recordStatus('Connected, but Turing Wallet did not return a TBC address. Select a TBC account in the extension and reconnect.');
          return;
        }
        setAddress(connectedAddress);
        setNetwork(currentNetwork);
        recordStatus(currentNetwork?.network === 'tbc' && currentNetwork?.type === 'testnet'
          ? 'Devnet connected. Review your token details, then mint.'
          : 'Connected, but switch the wallet to TBC Devnet before minting.');
      } catch (error) {
        logData = { error };
        recordStatus(`Connection failed: ${error.message ?? String(error)}`);
      } finally {
        setBusy(false);
      }
    
    } finally {
      await logAction('Connect', logData ?? { status: 'No wallet response' });
    }
  }

  return { wallet, address, network, walletInfo, status, setStatus, result, setResult, busy, setBusy, networkIsDevnet, connect };
}
