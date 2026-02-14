document.addEventListener('DOMContentLoaded', () => {
  loadData();
  
  // === SCAN BUTTON LOGIC ===
  document.getElementById('scanBtn').addEventListener('click', () => {
    const btn = document.getElementById('scanBtn');
    const status = document.getElementById('status');
    
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const url = tabs[0].url;
      
      // 1. DETERMINE SITE
      let scraperFunction = null;
      let siteName = "";

      if (url.includes("zepto")) {
        scraperFunction = scrapeZepto;
        siteName = "Zepto";
      } else if (url.includes("blinkit")) {
        scraperFunction = scrapeBlinkitV2; // Using the NEW scraper
        siteName = "Blinkit";
      } else {
        status.textContent = "❌ Go to Zepto or Blinkit Orders page first!";
        return;
      }

      // 2. RUN SCRAPER
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
            status.textContent = "⚠️ Found 0 orders. Try scrolling down more!";
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
    let added = 0;
    newOrders.forEach(item => {
      item.source = source; 
      // Avoid duplicates (Date + Price check)
      if (!existing.some(e => e.date === item.date && e.price === item.price)) {
        existing.push(item);
        added++;
      }
    });
    // Refresh display
    chrome.storage.local.set({ expenses: existing }, () => {
        loadData();
        const status = document.getElementById('status');
        if(added > 0) status.textContent = `✅ Saved ${added} new orders!`;
        else status.textContent = `ℹ️ No new orders found (Duplicates skipped).`;
    });
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
        // Simple cleanup: take first 2 words
        let name = p.replace(/[0-9]/g, '').trim().split(' ').slice(0, 2).join(' ');
        if(name.length > 2) counts[name] = (counts[name] || 0) + 1;
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
      const badgeColor = o.source === "Blinkit" ? "#f8cb46;color:black" : "#3d0752;color:white";
      return `
      <div class="row">
        <div>
            <span style="background:${badgeColor}; padding:2px 6px; border-radius:4px; font-size:10px;">${o.source || 'App'}</span> 
            <span style="font-size:11px; color:#888">${o.date}</span>
        </div>
        <span class="price-tag">₹${o.price}</span>
      </div>`;
    }).join('');
  });
}

// --- ZEPTO SCRAPER (Unchanged) ---
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

// --- NEW BLINKIT SCRAPER (Regex + Robustness) ---
function scrapeBlinkitV2() {
  const orders = [];
  
  // Regex to find "₹123 ... 08 Feb" pattern
  // Matches: ₹ followed by digits, then ANY characters (.*?), then a Date (Digit + Month)
  const pattern = /₹\s?([0-9,]+).*?(\d{1,2}\s[A-Z][a-z]{2})/;
  
  const allElements = document.querySelectorAll('*');
  
  allElements.forEach(el => {
    // Only look at elements with direct text (leaf nodes)
    if(el.children.length === 0 && el.innerText) {
       const text = el.innerText.trim();
       const match = text.match(pattern);
       
       if(match) {
           const price = parseFloat(match[1].replace(/,/g, ''));
           const dateStr = match[2]; // e.g., "08 Feb"
           
           // Find the Card Container to get images
           let card = el.parentElement;
           let products = [];
           
           // Climb up to find images (max 6 levels)
           for(let k=0; k<6; k++) {
              if(!card) break;
              
              // Look for images in this container
              const imgs = card.querySelectorAll('img');
              if(imgs.length > 0) {
                  imgs.forEach(img => {
                      const src = (img.src || "").toLowerCase();
                      const alt = (img.alt || "").trim();
                      
                      // Skip UI icons
                      if(src.includes('arrow') || src.includes('clock') || src.includes('icon') || src.includes('star')) return;
                      
                      // If alt text exists, use it. If not, it's a mystery item.
                      if(alt.length > 1) products.push(alt);
                      else if(img.width > 30) products.push("Blinkit Item"); 
                  });
                  
                  // If we found valid products, we assume this is the right card level
                  // But we filter "Blinkit Item" if we have better names
                  const realNames = products.filter(n => n !== "Blinkit Item");
                  if(realNames.length > 0) products = realNames;
                  
                  if(products.length > 0) break; 
              }
              card = card.parentElement;
           }
           
           // If no products found, default to generic
           if(products.length === 0) products.push("Blinkit Order");

           orders.push({
               date: dateStr,
               price: price,
               products: products
           });
       }
    }
  });
  
  return orders;
}
