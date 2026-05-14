document.addEventListener('DOMContentLoaded', () => {
    const searchForm = document.getElementById('searchForm');
    const sectorInput = document.getElementById('sectorInput');
    const searchBtn = document.getElementById('searchBtn');
    
    const statusPanel = document.getElementById('statusPanel');
    const statusText = document.getElementById('statusText');
    const leadCountEl = document.getElementById('leadCount');
    const loader = document.querySelector('.loader');
    
    const aiTagsContainer = document.getElementById('aiTagsContainer');
    const tagsList = document.getElementById('tagsList');

    const resultsWrapper = document.getElementById('resultsWrapper');
    const resultsTableBody = document.getElementById('resultsTableBody');
    const exportBtn = document.getElementById('exportBtn');

    let eventSource = null;
    let foundLeads = [];

    searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const sector = sectorInput.value.trim();
        if (!sector) return;

        startSearch(sector);
    });

    exportBtn.addEventListener('click', () => {
        if (foundLeads.length === 0) return;
        
        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Email,Hedef Kitle,Kaynak,Snippet\n";

        foundLeads.forEach(lead => {
            const email = `"${lead.email}"`;
            const tag = `"${lead.tag || '-'}"`;
            const source = `"${lead.source}"`;
            const snippet = `"${lead.snippet.replace(/"/g, '""')}"`;
            csvContent += `${email},${tag},${source},${snippet}\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `leads_${new Date().getTime()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    function startSearch(sector) {
        if (eventSource) {
            eventSource.close();
        }
        
        foundLeads = [];
        resultsTableBody.innerHTML = '';
        leadCountEl.textContent = '0';
        
        statusPanel.classList.remove('hidden');
        resultsWrapper.classList.add('hidden');
        aiTagsContainer.classList.add('hidden');
        tagsList.innerHTML = '';

        loader.style.display = 'block';
        statusText.textContent = `Yapay zeka "${sector}" için hedefleri belirliyor...`;
        searchBtn.disabled = true;

        const locationValue = document.getElementById('locationInput').value;
        eventSource = new EventSource(`/api/search?sector=${encodeURIComponent(sector)}&location=${encodeURIComponent(locationValue)}`);

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                if (data.type === 'status') {
                    statusText.textContent = data.message;
                } 
                else if (data.type === 'tags') {
                    // Yapay zeka tagleri gönderdi
                    aiTagsContainer.classList.remove('hidden');
                    tagsList.innerHTML = data.data.map(t => `<span class="badge" style="margin-right: 5px; background: rgba(59, 130, 246, 0.2); color: #60a5fa; border-color: rgba(59, 130, 246, 0.3);">${t}</span>`).join('');
                }
                else if (data.type === 'lead') {
                    addLeadToTable(data.data);
                    foundLeads.push(data.data);
                    leadCountEl.textContent = foundLeads.length;
                    
                    if (foundLeads.length === 1) {
                        resultsWrapper.classList.remove('hidden');
                    }
                }
                else if (data.type === 'complete' || data.type === 'done') {
                    finishSearch(`Arama tamamlandı. Toplam ${foundLeads.length} müşteri bulundu.`);
                }
                else if (data.type === 'error') {
                    finishSearch(`Hata: ${data.message}`, true);
                }
            } catch (err) {
                console.error("SSE Parse Error:", err);
            }
        };

        eventSource.onerror = (err) => {
            console.error("EventSource failed:", err);
            finishSearch("Bağlantı koptu.", true);
        };
    }

    function addLeadToTable(lead) {
        const tr = document.createElement('tr');

        // Email türüne göre rozet
        let badge = '';
        let emailIcon = '<i class="fa-regular fa-envelope" style="color: var(--primary); margin-right: 8px;"></i>';
        if (lead.title && lead.title.includes('[MX✅]')) {
            badge = '<span style="font-size:0.7rem; background:rgba(16,185,129,0.2); color:#10b981; border:1px solid rgba(16,185,129,0.4); border-radius:4px; padding:1px 5px; margin-left:6px;">MX Doğrulandı</span>';
            emailIcon = '<i class="fa-solid fa-check-circle" style="color: #10b981; margin-right: 8px;"></i>';
        } else if (lead.title && lead.title.includes('[TR🇹🇷 Web]')) {
            badge = '<span style="font-size:0.7rem; background:rgba(220,38,38,0.2); color:#f87171; border:1px solid rgba(220,38,38,0.4); border-radius:4px; padding:1px 5px; margin-left:6px;">🇹🇷 Türk Site</span>';
            emailIcon = '<i class="fa-solid fa-globe" style="color: #f87171; margin-right: 8px;"></i>';
        } else if (lead.title && lead.title.includes('[Web]')) {
            badge = '<span style="font-size:0.7rem; background:rgba(59,130,246,0.2); color:#60a5fa; border:1px solid rgba(59,130,246,0.4); border-radius:4px; padding:1px 5px; margin-left:6px;">Web Sayfası</span>';
            emailIcon = '<i class="fa-solid fa-globe" style="color: #60a5fa; margin-right: 8px;"></i>';
        }

        const emailCell = document.createElement('td');
        emailCell.className = 'email-cell';
        emailCell.innerHTML = `${emailIcon}<strong>${lead.email}</strong>${badge}<br><small style="color: var(--text-muted); font-weight: normal;"><i class="fa-solid fa-tag"></i> ${lead.tag}</small>`;

        const sourceCell = document.createElement('td');
        sourceCell.className = 'source-cell';
        let hostname = 'Arama';
        try { hostname = new URL(lead.source).hostname; } catch {}
        const displayTitle = lead.title.replace(/\[MX✅\]|\[TR🇹🇷 Web\]|\[Web\]/g, '').trim();
        sourceCell.innerHTML = `<strong>${displayTitle.substring(0, 55)}${displayTitle.length > 55 ? '…' : ''}</strong><br><a href="${lead.source}" target="_blank" rel="noopener"><i class="fa-solid fa-link"></i> ${hostname}</a>`;

        const actionCell = document.createElement('td');
        actionCell.innerHTML = `<button class="btn-secondary" onclick="window.location.href='mailto:${lead.email}'"><i class="fa-solid fa-paper-plane"></i> Yaz</button>`;

        tr.appendChild(emailCell);
        tr.appendChild(sourceCell);
        tr.appendChild(actionCell);

        resultsTableBody.insertBefore(tr, resultsTableBody.firstChild);
    }

    function finishSearch(msg, isError = false) {
        if (eventSource) {
            eventSource.close();
        }
        searchBtn.disabled = false;
        loader.style.display = 'none';
        statusText.textContent = msg;
        if (isError) {
            statusText.style.color = '#ef4444'; 
        } else {
            statusText.style.color = 'var(--accent)';
        }
    }
});
