function extractStoryText() {
    const paragraphs = Array.from(document.querySelectorAll('p, div, article, section'));
    let fullText = '';
  
    paragraphs.forEach(p => {
      if (p.textContent.trim().length > 50) { // Only include meaningful text
        fullText += p.textContent + '\n\n';
      }
    });
  
    return fullText;
  }
  
  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getStoryText") {
      const storyText = extractStoryText();
      sendResponse({ storyText });
    }
  });