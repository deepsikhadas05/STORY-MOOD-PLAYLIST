let spotifyAccessToken = null;
let codeVerifier = "";

// ====================== PKCE HELPER FUNCTIONS ======================
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values).map(byte => possible[byte % possible.length]).join('');
}

async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ====================== MOOD DETECTION ======================
function detectMood(text) {
  // Expanded mood keywords with weights and context phrases
  const moodPatterns = {
    happy: {
      keywords: ["happy", "joy", "laugh", "smile", "celebrate", "excited", "delight", "cheerful"],
      phrases: ["feeling good", "so glad", "made me happy", "full of joy"],
      weight: 1.2
    },
    sad: {
      keywords: ["sad", "cry", "tears", "depressed", "grief", "lonely", "heartbreak", "miss"],
      phrases: ["feeling down", "made me cry", "so upset", "can't stop crying"],
      weight: 1.3 // Sadness often has stronger signals
    },
    angry: {
      keywords: ["angry", "rage", "furious", "hate", "revenge", "betrayed", "mad", "outraged"],
      phrases: ["made me angry", "so pissed", "seeing red", "blood boiling"],
      weight: 1.4 // Anger expressions are usually intense
    },
    romantic: {
      keywords: ["love", "romance", "kiss", "heart", "passion", "affection", "crush", "adore"],
      phrases: ["falling in love", "made my heart", "soulmate", "butterflies in"],
      weight: 1.1
    },
    intense: {
      keywords: ["thriller", "mystery", "horror", "suspense", "action", "adrenaline", "danger", "chase"],
      phrases: ["edge of my seat", "heart pounding", "couldn't look away", "gripping story"],
      weight: 1.2
    }
  };

  const moodScores = { happy: 0, sad: 0, angry: 0, romantic: 0, intense: 0 };
  const normalizedText = text.toLowerCase().replace(/[^\w\s]/g, ' ');

  // Check for phrases first (higher confidence)
  for (const mood in moodPatterns) {
    moodPatterns[mood].phrases.forEach(phrase => {
      if (normalizedText.includes(phrase)) {
        moodScores[mood] += 3 * moodPatterns[mood].weight; // Phrases are strong indicators
      }
    });
  }

  // Then check individual keywords
  normalizedText.split(/\s+/).forEach(word => {
    for (const mood in moodPatterns) {
      if (moodPatterns[mood].keywords.includes(word)) {
        moodScores[mood] += 1 * moodPatterns[mood].weight;
      }
    }
  });

  // Calculate sentence sentiment (additional check)
  const sentences = text.split(/[.!?]+/);
  sentences.forEach(sentence => {
    if (sentence.length > 5) { // Ignore very short sentences
      const lowerSentence = sentence.toLowerCase();
      for (const mood in moodPatterns) {
        moodPatterns[mood].keywords.forEach(keyword => {
          if (lowerSentence.includes(keyword)) {
            moodScores[mood] += 0.5; // Extra points for sentence-level matches
          }
        });
      }
    }
  });

  // Find top mood with minimum threshold
  let topMood = "neutral";
  let topScore = 0;
  
  for (const mood in moodScores) {
    if (moodScores[mood] > topScore) {
      topScore = moodScores[mood];
      topMood = mood;
    }
  }

  // Only return a mood if we have strong confidence
  return topScore >= 4 ? topMood : "neutral";
}

// ====================== SPOTIFY AUTH (PKCE) ======================
async function handleSpotifyAuth() {
  const clientId = "926283ebd7614ce59d2a0bf32b880e6d";
  const redirectUri = chrome.identity.getRedirectURL("spotify-auth");
  
  // PKCE Setup
  codeVerifier = generateRandomString(128);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authUrl = new URL("https://accounts.spotify.com/authorize");
  authUrl.searchParams.append("client_id", clientId);
  authUrl.searchParams.append("response_type", "code");
  authUrl.searchParams.append("redirect_uri", redirectUri);
  authUrl.searchParams.append("scope", "playlist-read-private");
  authUrl.searchParams.append("code_challenge_method", "S256");
  authUrl.searchParams.append("code_challenge", codeChallenge);
  authUrl.searchParams.append("show_dialog", "true");

  try {
    // Launch auth flow
    const responseUrl = await new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({
        url: authUrl.toString(),
        interactive: true
      }, (url) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || "Auth popup closed"));
        } else {
          resolve(url);
        }
      });
    });

    // Extract authorization code
    const url = new URL(responseUrl);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Authorization code missing");

    // Exchange code for token
    const tokenResponse = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      throw new Error(tokenData.error || "No access token received");
    }

    // Store token with expiration
    chrome.storage.local.set({
      spotifyToken: tokenData.access_token,
      tokenExpiry: Date.now() + (tokenData.expires_in * 1000)
    });

    return {
      success: true,
      token: tokenData.access_token,
      expiresIn: tokenData.expires_in
    };

  } catch (error) {
    console.error("[Spotify Auth Error]", error);
    return {
      success: false,
      error: error.message || "Authentication failed"
    };
  }
}

// ====================== MESSAGE HANDLER ======================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case "detectMood":
      sendResponse({ mood: detectMood(request.text) });
      break;

    case "loginToSpotify":
      handleSpotifyAuth().then(sendResponse);
      return true; // Required for async response

    default:
      sendResponse({ error: "Unknown action" });
  }
});

// ====================== TOKEN MANAGEMENT ======================
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['spotifyToken', 'tokenExpiry'], (result) => {
    if (result.spotifyToken && result.tokenExpiry > Date.now()) {
      spotifyAccessToken = result.spotifyToken;
    } else if (result.spotifyToken) {
      // Clear expired token
      chrome.storage.local.remove(['spotifyToken', 'tokenExpiry']);
    }
  });
});

// Clear tokens when extension is updated
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove(['spotifyToken', 'tokenExpiry']);
});