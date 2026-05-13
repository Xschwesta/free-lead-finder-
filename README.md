# Müşteri Bulucu Ajan (Free Lead Finder)

Tamamen ücretsiz, API limitsiz ve kredisiz bir müşteri e-posta bulma otomasyonudur. Belirttiğiniz sektöre ait (örneğin "E-ticaret", "Yazılım Şirketleri", "Plumbers in London") potansiyel müşterilerin e-posta adreslerini arama motoru dorkları ve web kazıma (scraping) yöntemleriyle bulur.

## Özellikler
- **Sınırsız ve Ücretsiz:** Apollo.io, Hunter.io vb. platformlardaki kredi bitme derdi yoktur.
- **Gerçek Zamanlı (Real-time):** SSE (Server-Sent Events) teknolojisi ile tarama yapılırken sonuçlar anında ekrana düşer.
- **Şık Arayüz:** Karanlık mod ve glassmorphism tasarımlı modern web arayüzü.
- **Dışa Aktarma:** Bulunan tüm müşteri iletişim bilgilerini tek tıkla CSV olarak bilgisayarınıza indirebilirsiniz.

## Kurulum ve Çalıştırma

Terminalinizde aşağıdaki komutları çalıştırarak projeyi ayağa kaldırabilirsiniz:

```bash
cd c:\Users\aras.koclu\.gemini\antigravity\scratch\.agents\skills\free-lead-finder
npm install
npm start
```

Tarayıcınızda [http://localhost:3000](http://localhost:3000) adresine giderek Müşteri Bulucu Ajan'ı kullanmaya başlayabilirsiniz.

## Nasıl Çalışır?
- Girilen sektöre özel **Google Dorks** (örneğin `"{sektör}" "iletişim" "@gmail.com"`) oluşturur.
- DuckDuckGo gibi IP kısıtlamasının nispeten az olduğu motorların HTML versiyonlarını `axios` ile çeker.
- `cheerio` ile sonuçları ayıklar ve Özel Regex ile e-posta adreslerini çıkartıp sahte/gereksizleri eler.
