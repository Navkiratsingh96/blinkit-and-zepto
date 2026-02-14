document.addEventListener('DOMContentLoaded', () => {
  loadData();
  
  document.getElementById('scanBtn').addEventListener('click', () => {
    const btn = document.getElementById('scanBtn');
    const status = document.getElementById('status');
    
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      const url = tabs[0].url;
      let scraperFunction = null;
      let siteName = "";

      // 1. SELECT THE CORRECT SCRAPER
      if (url.includes("zepto")) {
        scraperFunction = scrapeZepto;
        siteName = "Zepto";
      } else if (url.includes("blinkit")) {
        scraperFunction = scrapeBlinkit;
        siteName = "Blinkit";
      } else if (url.includes("swiggy")) {
        scraperFunction = scrapeSwiggy; // NEW!
        siteName = "Swiggy";
      } else {
        status.textContent = "❌ Open Zepto, Blinkit, or Swiggy orders page.";
        return;
      }

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
            status.textContent = "⚠️ Found 0 orders. Scroll down to load more!";
          } else {
            saveData(data, siteName);
            status.textContent = `✅ Saved ${data.length} ${siteName} orders!`;
          }
        } else {
           status.textContent = "❌ Error. Try reloading the page.";
        }
      });
    });
  });

  document.getElementById('clearBtn').addEventListener('click', () => {
    if(confirm("Delete all history?")) chrome.storage.local.clear(loadData);
  });
});

function saveData(newOrders, source) {
  chrome.storage.local.get(['expenses'], (result) => {
    const existing = result.expenses || [];
    let added = 0;
    newOrders.forEach(item => {
      item.source = source; 
      if (!existing.some(e => e.date === item.date && e.price === item.price)) {
        existing.push(item);
        added++;
      }
    });
    chrome.storage.local.set({ expenses: existing }, loadData);
  });
}

function loadData() {
  chrome.storage.local.get(['expenses'], (result) => {
    const expenses = result.expenses || [];
    if (expenses.length > 0) document.getElementById('results').style.display = 'block';

    const total = expenses.reduce((sum, i) => sum + i.price, 0);
    document.getElementById('totalAmount').innerText = '₹' + total.toLocaleString('en-IN');
    document.getElementById('orderCount').innerText = expenses.length + ' Orders';

    // Top Products / Restaurants
    const counts = {};
    expenses.forEach(o => {
      o.products.forEach(p => {
        let name = p.trim();
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

    // Recent Big Orders
    const sortedPrice = [...expenses].sort((a,b) => b.price - a.price).slice(0, 5);
    document.getElementById('bigList').innerHTML = sortedPrice.map(o => {
      let color = "#333";
      if(o.source === "Zepto") color = "#3d0752";
      if(o.source === "Blinkit") color = "#f8cb46";
      if(o.source === "Swiggy") color = "#fc8019";
      
      return `
      <div class="row">
        <div>
            <span style="background:${color}; color:${o.source==='Blinkit'?'black':'white'}; padding:2px 6px; border-radius:4px; font-size:10px;">${o.source}</span> 
            <span style="font-size:11px; color:#888">${o.date}</span>
        </div>
        <span class="price-tag">₹${o.price}</span>
      </div>`;
    }).join('');
  });
}

// --- SCRAPER: ZEPTO ---
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
         if(!alt.includes('arrow') && !alt.includes('icon') && !img.src.includes('.svg') && img.alt.length>1) {
             products.push(img.alt);
         }
      });
      if (price > 0) orders.push({ date: cleanDate, price, products });
    }
  }
  return orders;
}

// --- SCRAPER: BLINKIT ---
function scrapeBlinkit() {
  const orders = [];
  const allElements = document.querySelectorAll('*');
  allElements.forEach(el => {
    // Look for text node containing "₹" and "•" (Dot separator)
    if(el.children.length === 0 && el.innerText && el.innerText.includes('₹') && el.innerText.includes('•')) {
       const text = el.innerText;
       const match = text.match(/₹\s?([0-9,]+).*?(\d{1,2}\s[A-Z][a-z]{2})/); // Matches "₹55 ... 08 Feb"
       if(match) {
           const price = parseFloat(match[1].replace(/,/g, ''));
           const dateStr = match[2];
           orders.push({ date: dateStr, price: price, products: ["Blinkit Order"] });
       }
    }
  });
  return orders;
}

// --- SCRAPER: SWIGGY (New!) ---
function scrapeSwiggy() {
  const orders = [];
  
  // 1. Find elements containing "Total Paid: ₹"
  const xpath = "//*[contains(text(), 'Total Paid:')]";
  const snapshot = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

  for (let i = 0; i < snapshot.snapshotLength; i++) {
    const priceEl = snapshot.snapshotItem(i);
    
    // 2. Extract Price
    const priceText = priceEl.innerText; // "Total Paid: ₹ 80"
    const priceMatch = priceText.match(/₹\s?([0-9,]+)/);
    if (!priceMatch) continue;
    const price = parseFloat(priceMatch[1].replace(/,/g, ''));

    // 3. Find Container Card (Go up parent levels)
    let card = priceEl.parentElement;
    let restaurantName = "Swiggy Order";
    let dateStr = "Unknown Date";

    // Climb up to find the whole order card
    for(let k=0; k<5; k++) {
        if(!card) break;
        const text = card.innerText;
        
        // Try to find Restaurant Name (Usually in an <h3> or similar at top)
        // Swiggy usually puts Restaurant Name in bold at the top of the card
        // We will look for the text "Delivered on" to find the date
        if(text.includes("Delivered on")) {
            const dateMatch = text.match(/Delivered on\s(.+)/); // "Delivered on Wed, Jan 21..."
            if(dateMatch) {
                // Cleanup: "Wed, Jan 21, 2026, 08:21 PM" -> "Jan 21, 2026"
                dateStr = dateMatch[1].split(',').slice(1,3).join(',').trim(); 
            }
        }
        
        // Grab the first non-empty header/div as restaurant name
        // This is a rough guess, but works for Swiggy's H3 tags
        const h3 = card.querySelector('h3, h4, .restaurant-name');
        if(h3) restaurantName = h3.innerText;

        card = card.parentElement;
    }

    orders.push({
        date: dateStr,
        price: price,
        products: [restaurantName] // Using Restaurant name as the "Product"
    });
  }
  return orders;
}
