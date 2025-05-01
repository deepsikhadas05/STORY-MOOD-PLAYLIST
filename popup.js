let spotifyAccessToken = null;

// Load saved token when popup opens
chrome.storage.local.get(['spotifyToken', 'tokenExpiry'], (result) => {
  if (result.spotifyToken && result.tokenExpiry > Date.now()) {
    spotifyAccessToken = result.spotifyToken;
    updateConnectionUI(true);
  } else if (result.spotifyToken) {
    // Clear expired token
    chrome.storage.local.remove(['spotifyToken', 'tokenExpiry']);
  }
});

// Spotify Login
document.getElementById("spotify-auth").addEventListener("click", async () => {
  const authButton = document.getElementById("spotify-auth");
  authButton.disabled = true;
  authButton.textContent = "Connecting...";
  
  try {
    const response = await chrome.runtime.sendMessage({ action: "loginToSpotify" });
    
    if (response.success) {
      spotifyAccessToken = response.token;
      chrome.storage.local.set({
        spotifyToken: response.token,
        tokenExpiry: Date.now() + (response.expiresIn * 1000)
      });
      updateConnectionUI(true);
    } else {
      updateConnectionUI(false);
      alert(`Spotify login failed: ${response.error || "Unknown error"}`);
    }
  } catch (error) {
    console.error("Login error:", error);
    updateConnectionUI(false);
    alert("Connection failed. Please try again.");
  } finally {
    authButton.disabled = false;
  }
});

// Analyze Page & Get Playlist
document.getElementById("analyze-btn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const playlistSection = document.getElementById("playlist-section");

  try {
    // Show loading state
    playlistSection.innerHTML = "<p>🎵 Analyzing mood and finding your perfect playlist...</p>";

    // Inject content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });

    // Get story text and detect mood
    const textResponse = await chrome.tabs.sendMessage(tab.id, { action: "getStoryText" });
    const moodResponse = await chrome.runtime.sendMessage({ 
      action: "detectMood", 
      text: textResponse.storyText 
    });
    const mood = moodResponse.mood;

    if (!spotifyAccessToken) {
      playlistSection.innerHTML = `
        <p>Detected Mood: <strong>${mood}</strong></p>
        <p style="color: red;">⚠️ Please connect to Spotify first</p>
      `;
      return;
    }

    // Get user-selected filters
    const genre = document.getElementById("genre-select").value;
    const language = document.getElementById("language-select").value;

    // Fetch playlist with filters
    const playlist = await fetchSpotifyPlaylist(mood, genre, language);
    
    // In the analyze-btn click handler, modify the playlist display section:
if (!playlist) {
    playlistSection.innerHTML = `
      <p>Detected Mood: <strong>${mood}</strong></p>
      <p>No exact playlist found for your filters. Try these instead:</p>
      <button class="retry-btn" data-mood="${mood}" data-genre="">Any Genre</button>
      <button class="retry-btn" data-mood="${mood}" data-genre="pop">Pop Music</button>
      <button class="retry-btn" data-mood="${mood}" data-genre="lofi">Lo-fi</button>
    `;
    
    // Add event listeners to retry buttons
    document.querySelectorAll('.retry-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const mood = btn.dataset.mood;
        const genre = btn.dataset.genre;
        const playlist = await fetchSpotifyPlaylist(mood, genre, language);
        // Display the new playlist...
      });
    });
    return;
  }

    // Display results
    playlistSection.innerHTML = `
      <div class="playlist-result">
        <h3>🎧 ${mood} Playlist</h3>
        ${genre ? `<p><strong>Genre:</strong> ${genre}</p>` : ''}
        ${language ? `<p><strong>Language:</strong> ${language}</p>` : ''}
        <a href="${playlist.external_urls.spotify}" target="_blank" class="playlist-link">
          <img src="${playlist.images[0]?.url || 'https://via.placeholder.com/200'}" width="200">
          <p><strong>${playlist.name}</strong></p>
        </a>
        <small>By ${playlist.owner.display_name}</small>
      </div>
    `;

  } catch (error) {
    console.error("Analysis failed:", error);
    playlistSection.innerHTML = `
      <p style="color: red;">❌ Error: ${error.message || "Failed to analyze page"}</p>
    `;
  }
});

// Fetch Spotify playlist with filters
async function fetchSpotifyPlaylist(mood, genre, language) {
    try {
      // Build a more sophisticated search query
      let queryParts = [];
      
      // Add mood keywords based on detected mood
      const moodKeywords = {
        happy: ["happy", "joyful", "upbeat", "positive"],
        sad: ["sad", "melancholic", "emotional", "chill"],
        angry: ["angry", "intense", "aggressive", "powerful"],
        romantic: ["romantic", "love", "passionate", "sensual"],
        intense: ["intense", "thrilling", "dramatic", "epic"],
        neutral: ["mood", "focus", "background", "study"]
      };
      
      // Start with mood-specific keywords
      queryParts = queryParts.concat(moodKeywords[mood] || moodKeywords.neutral);
      
      // Add genre if specified
      if (genre) {
        queryParts.push(genre);
        
        // Special handling for certain genres
        if (genre === "kpop") {
          queryParts.push("k-pop", "kpop");
        } else if (genre === "lofi") {
          queryParts.push("study beats", "chillhop");
        }
      }
      
      // Add language if specified (and not English)
      if (language && language !== "english") {
        queryParts.push(language);
      }
      
      // Remove duplicates and create final query
      const uniqueQueryParts = [...new Set(queryParts)];
      let query = uniqueQueryParts.join(" ");
      
      // Search for playlists
      const response = await fetch(
        `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=10`,
        {
          headers: { 
            "Authorization": `Bearer ${spotifyAccessToken}`,
            "Content-Type": "application/json"
          }
        }
      );
  
      if (!response.ok) {
        throw new Error(`Spotify API error: ${response.status}`);
      }
  
      const data = await response.json();
      const playlists = data.playlists?.items || [];
      
      // If no results, try a broader search without language
      if (playlists.length === 0 && language && language !== "english") {
        return await fetchSpotifyPlaylist(mood, genre, "");
      }
      
      // Filter out any null/undefined playlists and those without required fields
      const validPlaylists = playlists.filter(playlist => 
        playlist && 
        playlist.external_urls && 
        playlist.external_urls.spotify && 
        playlist.name
      );
      
      // If no valid playlists found, return null
      if (validPlaylists.length === 0) {
        return null;
      }
      
      // Sort by followers (with fallback to 0 if missing) and return the most popular
      return validPlaylists.sort((a, b) => 
        (b.followers?.total || 0) - (a.followers?.total || 0)
      )[0];
    } catch (error) {
      console.error("Playlist fetch failed:", error);
      throw new Error("Couldn't fetch playlist. Please try again.");
    }
  }

// Update connection UI state
// Update connection UI state
function updateConnectionUI(isConnected) {
  const authButton = document.getElementById("spotify-auth");
  if (isConnected) {
    authButton.innerHTML = `
      <span class="button-icon">✓</span>
      <span class="button-text">Connected to Spotify</span>
    `;
    authButton.classList.add("connected");
  } else {
    authButton.innerHTML = `
      <span class="button-icon">🔌</span>
      <span class="button-text">Connect to Spotify</span>
    `;
    authButton.classList.remove("connected");
  }
}

// In your analyze-btn click handler, update the loading state:
playlistSection.innerHTML = `
  <div class="loading-message">
    <div class="loading-spinner"></div>
    <p>Analyzing mood and finding your perfect playlist...</p>
  </div>
`;