// Service worker de la versión instalable: guarda la aplicación en el celular para abrirla sin señal.
// Nunca intercepta los envíos (POST): esos los maneja la propia aplicación con su cola.
var CACHE = 'encuesta-zonas-verdes-lavado-zaragoza-e34d7bf01559';
var PREFIJO = 'encuesta-zonas-verdes-lavado-zaragoza-';
var ARCHIVOS = ['./', 'index.html', 'app.js', 'estilos.css', 'validacion.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
var FUENTES = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ARCHIVOS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (claves) {
      return Promise.all(claves.filter(function (k) { return k.indexOf(PREFIJO) === 0 && k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var pedido = e.request;
  if (pedido.method !== 'GET') return;
  var url = new URL(pedido.url);

  if (url.origin === self.location.origin) {
    // Primero lo guardado, y en segundo plano se refresca: la encuesta abre sin señal y se actualiza sola.
    e.respondWith(caches.open(CACHE).then(function (cache) {
      return cache.match(pedido, { ignoreSearch: true }).then(function (guardado) {
        var red = fetch(pedido).then(function (respuesta) {
          if (respuesta.ok) cache.put(pedido, respuesta.clone());
          return respuesta;
        }).catch(function () { return guardado; });
        return guardado || red;
      });
    }));
    return;
  }

  if (FUENTES.indexOf(url.hostname) >= 0) {
    e.respondWith(caches.open(CACHE).then(function (cache) {
      return cache.match(pedido).then(function (guardado) {
        return guardado || fetch(pedido).then(function (respuesta) {
          cache.put(pedido, respuesta.clone());
          return respuesta;
        });
      });
    }));
  }
});
