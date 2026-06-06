import { useState, useEffect, useCallback } from 'react';
import Login from './components/Login';
import Dashboard from './components/Dashboard';

const CLIENT_ID = '888567918479-oj26if3p94r6kru0vga9njaob9iql423.apps.googleusercontent.com';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [userProfile, setUserProfile] = useState(null);
  const [accessToken, setAccessToken] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [tokenClient, setTokenClient] = useState(null);

  const fetchUserProfile = useCallback(async (token) => {
    try {
      const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        // Token is expired/invalid, clear it
        console.warn('Access token invalid or expired, clearing cached token');
        localStorage.removeItem('drive_access_token');
        return false;
      }

      const data = await response.json();
      setUserProfile(data);
      return true;
    } catch (error) {
      console.error('Error fetching user profile:', error);
      localStorage.removeItem('drive_access_token');
      return false;
    }
  }, []);

  const handleLogout = useCallback(() => {
    if (accessToken && window.google?.accounts?.oauth2) {
      try {
        window.google.accounts.oauth2.revoke(accessToken);
      } catch (e) {
        console.error('Revoke failed:', e);
      }
    }
    localStorage.removeItem('drive_access_token');
    setAccessToken(null);
    setIsAuthenticated(false);
    setUserProfile(null);
  }, [accessToken]);

  useEffect(() => {
    let cancelled = false;

    const initGis = () => {
      if (!window.google?.accounts?.oauth2) return false;

      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (resp) => {
          if (resp.error !== undefined) {
            console.error('GIS token error:', resp);
            return;
          }

          // Verify the Drive scope was actually granted
          const hasDriveScope = window.google.accounts.oauth2.hasGrantedAllScopes(
            resp,
            'https://www.googleapis.com/auth/drive'
          );

          if (!hasDriveScope) {
            alert("You MUST allow access to Google Drive files! Please log in again and check the permission box.");
            return;
          }

          setIsLoading(true);
          localStorage.setItem('drive_access_token', resp.access_token);
          setAccessToken(resp.access_token);

          const success = await fetchUserProfile(resp.access_token);
          if (success && !cancelled) {
            setIsAuthenticated(true);
          }
          if (!cancelled) {
            setIsLoading(false);
          }
        },
      });
      setTokenClient(client);
      return true;
    };

    const initialize = async () => {
      // Try to initialize GIS immediately
      if (initGis()) {
        // Check for cached token
        const cachedToken = localStorage.getItem('drive_access_token');
        if (cachedToken) {
          const success = await fetchUserProfile(cachedToken);
          if (success && !cancelled) {
            setAccessToken(cachedToken);
            setIsAuthenticated(true);
          }
        }
        if (!cancelled) {
          setIsLoading(false);
        }
        return;
      }

      // GIS not loaded yet, poll until available
      const checkGis = setInterval(() => {
        if (cancelled) {
          clearInterval(checkGis);
          return;
        }
        if (initGis()) {
          clearInterval(checkGis);
          // Check for cached token
          const cachedToken = localStorage.getItem('drive_access_token');
          if (cachedToken) {
            fetchUserProfile(cachedToken).then((success) => {
              if (success && !cancelled) {
                setAccessToken(cachedToken);
                setIsAuthenticated(true);
              }
              if (!cancelled) {
                setIsLoading(false);
              }
            });
          } else {
            if (!cancelled) {
              setIsLoading(false);
            }
          }
        }
      }, 200);

      // Timeout after 10 seconds if GIS never loads
      setTimeout(() => {
        clearInterval(checkGis);
        if (!cancelled && !tokenClient) {
          setIsLoading(false);
          console.warn('Google Identity Services failed to load. Check your network connection.');
        }
      }, 10000);
    };

    initialize();

    return () => {
      cancelled = true;
    };
  }, [fetchUserProfile]);

  const handleLogin = useCallback(() => {
    if (tokenClient) {
      // Request token with consent to ensure all scopes are granted
      tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
      alert("Google Login is still loading. Please wait a moment and try again.");
    }
  }, [tokenClient]);

  if (isLoading) {
    return (
      <div className="login-container">
        <div className="loader"></div>
        <p style={{ marginTop: '16px', color: 'var(--text-secondary)' }}>Loading...</p>
      </div>
    );
  }

  return (
    <>
      {!isAuthenticated || !userProfile ? (
        <Login onLogin={handleLogin} />
      ) : (
        <Dashboard
          userProfile={userProfile}
          accessToken={accessToken}
          onLogout={handleLogout}
        />
      )}
    </>
  );
}

export default App;
