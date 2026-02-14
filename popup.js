document.addEventListener('DOMContentLoaded', () => {
  loadData();
  
  // === SCAN BUTTON LOGIC ===
  document.getElementById('scanBtn').addEventListener('click', () => {
    const btn = document.getElementById('scanBtn');
    const status = document.getElementById('status');
    
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const url = tabs[0].url;
      
      // 1. DETERMINE WHICH SITE WE ARE ON
      let scraperFunction = null;
      let siteName = "";

      if (url.includes("zepto")) {
        scraperFunction = scrapeZepto;
        siteName = "Zepto";
      } else if (url.includes("blinkit")) {
        scraperFunction = scrapeBlinkit;
        siteName = "Blinkit";
      } else {
        status.textContent = "❌ Go to Zepto or Blinkit Orders page first!";
        return;
      }

      // 2. RUN THE MATCHING SCRAPER
      btn.disabled = true;
      btn.innerText = `Scanning ${siteName}...`;
      status.textContent = "Analyzing page...";

      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        function: scraperFunction
      }, (results) => {
        btn.disabled = false;
        btn.innerText = "🔄 Scan Current Page";
        
        if (results && results[0] && results[0].result) {
          const data = results[0].result;
          if (data.length === 0) {
            status.textContent = "⚠️ Found 0 orders. Did you SCROLL DOWN?";
          } else {
            saveData(data, siteName);
            status.textContent = `✅ Added ${data.length} ${siteName} orders!`;
          }
        } else {
           status.textContent = "❌ Error reading page. Reload and try again.";
        }
      });
    });
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if(confirm("Delete all history?")) chrome.storage.local.clear(loadData);
  });
});

// === DATA SAVING ===
function saveData(newOrders, source) {
  chrome.storage.local.get(['expenses'], (result) => {
    const existing = result.expenses || [];
    newOrders.forEach(item => {
      // Add source tag (Zepto/Blinkit)
      item.source = source; 
      // Avoid duplicates
      if (!existing.some(e => e.date === item.date && e.price === item.price)) {
        existing.push(item);
      }
    });
    chrome.storage.local.set({ expenses: existing }, loadData);
  });
}

// === DASHBOARD RENDERER ===
function loadData() {
  chrome.storage.local.get(['expenses'], (result) => {
    const expenses = result.expenses || [];
    if (expenses.length > 0) document.getElementById('results').style.display = 'block';

    // 1. TOTALS
    const total = expenses.reduce((sum, i) => sum + i.price, 0);
    document.getElementById('totalAmount').innerText = '₹' + total.toLocaleString('en-IN');
    document.getElementById('orderCount').innerText = expenses.length + ' Orders';

    // 2. TOP PRODUCTS
    const counts = {};
    expenses.forEach(o => {
      o.products.forEach(p => {
        let name = p.split(' ').slice(0, 2).join(' '); // Group by first 2 words
        counts[name] = (counts[name] || 0) + 1;
      });
    });
    const sortedProds = Object.keys(counts).sort((a,b) => counts[b] - counts[a]).slice(0, 5);
    
    document.getElementById('topList').innerHTML = sortedProds.map(p => `
      <div class="row">
        <span class="prod-name">${p}</span> 
        <span style="font-weight:bold; font-size:11px; background:#eee; padding:2px 6px; border-radius:4px">${counts[p]}x</span>
      </div>
    `).join('');

    // 3. BIG ORDERS
    const sortedPrice = [...expenses].sort((a,b) => b.price - a.price).slice(0, 5);
    document.getElementById('bigList').innerHTML = sortedPrice.map(o => {
      const badgeClass = o.source === "Blinkit" ? "badge-blinkit" : "badge-zepto";
      return `
      <div class="row">
        <div><span class="${badgeClass}">${o.source || 'Zepto'}</span> <span style="font-size:11px; color:#888">${o.date}</span></div>
        <span class="price-tag">₹${o.price}</span>
      </div>`;
    }).join('');
  });
}

// ==========================================
// SCRAPER 1: ZEPTO (The one you verified works)
// ==========================================
function scrapeZepto() {
  const orders = [];
  const xpath = "//*[contains(text(), 'Placed at')]";
  const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

  for (let i = 0; i < snapshot.snapshotLength; i++) {
    let dateEl = snapshot.snapshotItem(i);
    let card = dateEl.parentElement;
    let validCard = null;

    for(let k=0; k<6; k++) {
       if(!card) break;
       if(card.innerText.match(/[₹|Rs]\s?[0-9,]+/)) {
          if((card.innerText.match(/Placed at/g)||[]).length === 1) validCard = card;
       }
       card = card.parentElement;
    }

    if (validCard) {
      const text = validCard.innerText;
      const priceMatch = text.match(/[₹|Rs]\s?([0-9,]+)/);
      const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
      const date = (text.match(/Placed at\s(.+)/) || [])[0] || "Unknown";
      // Cleanup Date for display
      const cleanDate = date.replace("Placed at ", "").split(",")[0];

      const products = [];
      validCard.querySelectorAll('img').forEach(img => {
         const alt = (img.alt || "").toLowerCase();
         if(alt.includes('arrow') || alt.includes('icon') || alt.includes('status') || img.src.includes('.svg')) return;
         if(img.alt.length > 1) products.push(img.alt);
      });

      if (price > 0) orders.push({ date: cleanDate, price, products });
    }
  }
  return orders;
}

// ==========================================
// SCRAPER 2: BLINKIT (New!)
// ==========================================
function scrapeBlinkit() {
  const orders = [];
  
  // Blinkit uses a specific format: "₹55 • 08 Feb, 6:47 pm"
  // We search for elements containing the "•" dot and the "₹" symbol
  const allDivs = document.querySelectorAll('div, p, span');
  
  allDivs.forEach(el => {
    // Check if text has the pattern "₹... • ..."
    // We strictly check for children length to avoid grabbing the main wrapper
    if (el.innerText.includes('₹') && el.innerText.includes('•') && el.children.length === 0) {
      
      const text = el.innerText;
      
      // 1. EXTRACT PRICE
      // Regex looks for ₹ followed by digits
      const priceMatch = text.match(/₹([0-9,]+)/);
      if (!priceMatch) return;
      const price = parseFloat(priceMatch[1].replace(/,/g, ''));
      
      // 2. EXTRACT DATE
      // Regex looks for text AFTER the dot
      const dateMatch = text.match(/•\s(.+)/);
      let dateStr = "Unknown";
      if (dateMatch) {
         // "08 Feb, 6:47 pm" -> just take "08 Feb" for simplicity
         dateStr = dateMatch[1].split(',')[0]; 
      }
      
      // 3. EXTRACT PRODUCTS
      // The image is usually in the "Grandparent" or "Great-Grandparent" of the text row
      const products = [];
      let card = el.parentElement;
      
      // Climb up 4 levels to find the row container
      for(let k=0; k<4; k++) {
         if(!card) break;
         const imgs = card.querySelectorAll('img');
         if(imgs.length > 0) {
             imgs.forEach(img => {
                 // Blinkit images usually don't have good Alt text, 
                 // but sometimes they do. If not, we just count them.
                 // We ignore icons which are usually small or SVGs
                 if(!img.src.includes('arrow') && !img.src.includes('icon')) {
                     products.push(img.alt || "Blinkit Item");
                 }
             });
             // If we found images, we assume this is the right card level
             if(products.length > 0) break;
         }
         card = card.parentElement;
      }

      orders.push({
          date: dateStr,
          price: price,
          products: products
      });
    }
  });
  
  return orders;
}
