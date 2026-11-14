(function () {
  'use strict';

  var enc = ENCUESTA;
  var raiz = document.getElementById('app');
  var secciones = enc.secciones;
  // Numeración fija por orden en la encuesta (solo se muestra; las columnas de la hoja no cambian).
  var numeros = {};
  preguntasDe_(enc).forEach(function (p, i) { numeros[p.id] = i + 1; });
  var claveBorrador = 'borrador:' + enc.id + ':' + enc.version;
  var claveRecordar = 'recordar:' + enc.id;
  var clavePerfil = 'perfil';
  var prefijoCola = 'cola:' + enc.id + ':';
  var TIEMPO_LIMITE_MS = 90000;
  var FOTO_LADO_MAX = 1600;
  var FOTO_CALIDAD = 0.78;

  var estado = { paso: 0, maxPaso: 0, resp: {}, codigo: '', autorizacion: false, errores: {}, pendientes: 0 };
  var enviandoCola = false;
  var nodos = {};

  document.documentElement.style.setProperty('--primario', enc.tema.primario);
  document.documentElement.style.setProperty('--acento', enc.tema.acento);

  // ---------- Utilidades de DOM: todo el texto entra por textContent, nunca como HTML ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'multiple') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) agregar(el, arguments[i]);
    return el;
  }
  function agregar(el, hijo) {
    if (hijo === undefined || hijo === null || hijo === false) return;
    if (Array.isArray(hijo)) { hijo.forEach(function (x) { agregar(el, x); }); return; }
    el.appendChild(typeof hijo === 'string' ? document.createTextNode(hijo) : hijo);
  }
  function icono(trazos) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'icono');
    svg.setAttribute('aria-hidden', 'true');
    trazos.forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }
  var ICONOS = {
    pin: ['M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z', 'M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
    camara: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
    galeria: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 9.5h.01']
  };

  // ---------- Almacén del dispositivo: borrador y cola de envíos ----------
  var almacen = (function () {
    var memoria = {};
    var conexion = null;
    function abrir() {
      if (conexion) return conexion;
      conexion = new Promise(function (ok, mal) {
        var r = indexedDB.open('encuestas', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { ok(r.result); };
        r.onerror = function () { mal(r.error); };
      });
      return conexion;
    }
    function operar(modo, fn) {
      return abrir().then(function (db) {
        return new Promise(function (ok, mal) {
          var tx = db.transaction('kv', modo);
          var req = fn(tx.objectStore('kv'));
          tx.oncomplete = function () { ok(req && req.result); };
          tx.onerror = function () { mal(tx.error); };
          tx.onabort = function () { mal(tx.error); };
        });
      });
    }
    return {
      poner: function (k, v) {
        return operar('readwrite', function (s) { return s.put(v, k); })
          .catch(function () { memoria[k] = v; });
      },
      leer: function (k) {
        return operar('readonly', function (s) { return s.get(k); })
          .catch(function () { return memoria[k]; });
      },
      borrar: function (k) {
        delete memoria[k];
        return operar('readwrite', function (s) { return s.delete(k); }).catch(function () {});
      },
      claves: function (prefijo) {
        return operar('readonly', function (s) { return s.getAllKeys(); })
          .catch(function () { return Object.keys(memoria); })
          .then(function (ks) { return (ks || []).filter(function (k) { return String(k).indexOf(prefijo) === 0; }); });
      }
    };
  })();

  var temporizadorBorrador = null;
  function guardarBorrador() {
    clearTimeout(temporizadorBorrador);
    temporizadorBorrador = setTimeout(function () {
      almacen.poner(claveBorrador, { resp: estado.resp, paso: estado.paso, maxPaso: estado.maxPaso });
    }, 400);
  }

  // ---------- Llamadas al servidor ----------
  // Dos transportes: dentro de Apps Script se usa google.script.run; en la versión instalable
  // (ENDPOINT definido) se envía por red a la misma aplicación web, sin cookies ni sesión de Google.
  function llamarRed(funcion, dato) {
    var control = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (control) control.abort(); }, TIEMPO_LIMITE_MS);
    return fetch(window.ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: funcion, dato: dato }),
      redirect: 'follow',
      credentials: 'omit',
      signal: control ? control.signal : undefined
    }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('http');
      return r.json();
    }, function (e) { clearTimeout(t); throw e; });
  }
  function llamar(funcion, dato) {
    if (window.ENDPOINT) return llamarRed(funcion, dato);
    return new Promise(function (ok, mal) {
      var listo = false;
      var t = setTimeout(function () { if (!listo) { listo = true; mal(new Error('tiempo')); } }, TIEMPO_LIMITE_MS);
      var fin = function (fn) { return function (x) { if (listo) return; listo = true; clearTimeout(t); fn(x); }; };
      google.script.run.withSuccessHandler(fin(ok)).withFailureHandler(fin(mal))[funcion](dato);
    });
  }
  function nuevoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var hex = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  // ---------- Cola: nada se pierde si se cae la señal; el id evita filas duplicadas al reintentar ----------
  function contarPendientes() {
    return almacen.claves(prefijoCola).then(function (ks) {
      estado.pendientes = ks.length;
      pintarAvisoCola();
      avisarCola();
      return ks;
    });
  }

  // Latido (solo en la versión instalable): le dice al panel de administración cuántas encuestas tiene
  // este celular sin enviar. Va con un id aleatorio del celular y un número, sin ningún dato de la encuesta.
  // Si falla no pasa nada: el aviso es informativo y la cola sigue su camino.
  var ultimoAviso = { n: 0, cuando: 0 };
  function avisarCola() {
    if (!window.ENDPOINT || navigator.onLine === false) return;
    var ahora = Date.now();
    var cambio = ultimoAviso.n !== estado.pendientes;
    if (!cambio && (estado.pendientes === 0 || ahora - ultimoAviso.cuando < 300000)) return;
    ultimoAviso = { n: estado.pendientes, cuando: ahora };
    almacen.leer('dispositivo').then(function (id) {
      if (id) return id;
      var nuevo = nuevoId();
      return almacen.poner('dispositivo', nuevo).then(function () { return nuevo; });
    }).then(function (id) {
      return llamar('latido', { encuestaId: enc.id, dispositivo: id, pendientes: estado.pendientes });
    }).catch(function () { ultimoAviso.cuando = 0; });
  }
  function vaciarCola() {
    if (enviandoCola) return Promise.resolve();
    enviandoCola = true;
    return contarPendientes().then(function (ks) {
      return ks.reduce(function (cadena, k) {
        return cadena.then(function (seguir) {
          if (!seguir) return false;
          return almacen.leer(k).then(function (envio) {
            if (!envio) return true;
            return llamar('enviarRespuesta', envio).then(function (r) {
              if (r.ok) return almacen.borrar(k).then(function () { return true; });
              return !r.reintentar;
            }).catch(function () { return false; });
          });
        });
      }, Promise.resolve(true));
    }).then(function () {
      enviandoCola = false;
      return contarPendientes();
    }, function () { enviandoCola = false; });
  }
  window.addEventListener('online', vaciarCola);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) vaciarCola(); });
  // El evento "online" no siempre llega: mientras haya envíos pendientes se reintenta cada minuto.
  setInterval(function () { if (estado.pendientes > 0 && navigator.onLine !== false) vaciarCola(); }, 60000);

  var eventoInstalar = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    eventoInstalar = e;
    var b = document.getElementById('instalar');
    if (b) b.classList.remove('oculto');
  });
  function botonInstalar() {
    if (!window.ENDPOINT) return null;
    return h('button', {
      type: 'button', id: 'instalar', class: 'boton-texto' + (eventoInstalar ? '' : ' oculto'),
      onclick: function () { if (eventoInstalar) { eventoInstalar.prompt(); eventoInstalar = null; } }
    }, 'Instalar en este celular');
  }

  function pintarAvisoCola() {
    var aviso = document.getElementById('aviso-cola');
    if (!aviso) return;
    aviso.classList.toggle('oculto', estado.pendientes === 0);
    var texto = document.getElementById('aviso-cola-texto');
    if (texto) {
      texto.textContent = estado.pendientes === 1
        ? '1 encuesta guardada en este celular, sin enviar.'
        : estado.pendientes + ' encuestas guardadas en este celular, sin enviar.';
    }
  }
  function avisoCola() {
    return h('div', { id: 'aviso-cola', class: 'aviso-cola oculto', role: 'status' },
      h('div', { class: 'barra-interior' },
        h('span', { id: 'aviso-cola-texto' }),
        h('button', { type: 'button', class: 'boton-texto', onclick: vaciarCola }, 'Enviar ahora')));
  }

  // ---------- Fotos: se reducen en el celular y al redibujarlas se borran los metadatos EXIF ----------
  function cargarImagen(archivo) {
    if (window.createImageBitmap) {
      return createImageBitmap(archivo, { imageOrientation: 'from-image' }).catch(function () { return imagenPorUrl(archivo); });
    }
    return imagenPorUrl(archivo);
  }
  function imagenPorUrl(archivo) {
    return new Promise(function (ok, mal) {
      var url = URL.createObjectURL(archivo);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); ok(img); };
      img.onerror = function () { URL.revokeObjectURL(url); mal(new Error('formato')); };
      img.src = url;
    });
  }
  function comprimirFoto(archivo) {
    return cargarImagen(archivo).then(function (img) {
      var ancho = img.width, alto = img.height;
      var escala = Math.min(1, FOTO_LADO_MAX / Math.max(ancho, alto));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(ancho * escala);
      canvas.height = Math.round(alto * escala);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      if (img.close) img.close();
      return { base64: canvas.toDataURL('image/jpeg', FOTO_CALIDAD).split(',')[1] };
    });
  }

  // ---------- Preguntas ----------
  function alCambiar(p) {
    if (estado.errores[p.id]) { delete estado.errores[p.id]; pintarError(p); }
    actualizarVisibles();
    guardarBorrador();
  }
  function fijar(p, v) { estado.resp[p.id] = v; alCambiar(p); }

  function pintarError(p) {
    var n = nodos[p.id];
    if (!n) return;
    var msg = estado.errores[p.id];
    n.envoltura.classList.toggle('invalida', !!msg);
    n.error.textContent = msg || '';
    n.error.classList.toggle('oculto', !msg);
  }

  function campoOtro(p, visible) {
    var entrada = h('input', {
      class: 'entrada otro-detalle' + (visible ? '' : ' oculto'), type: 'text', maxlength: 120,
      'aria-label': 'Escribe cuál', placeholder: 'Escribe cuál', value: estado.resp[p.id + '__otro'] || '',
      oninput: function (e) { estado.resp[p.id + '__otro'] = e.target.value; alCambiar(p); }
    });
    return entrada;
  }

  function controlSeleccion(p, ids) {
    var otro = etiquetaOtro_(p);
    var detalle = otro ? campoOtro(p, estado.resp[p.id] === otro) : null;
    function elegir(v) {
      if (detalle) detalle.classList.toggle('oculto', v !== otro);
      fijar(p, v);
      if (detalle && v === otro) detalle.focus();
    }
    if (controlDe_(p) === 'lista') {
      var sel = h('select', { class: 'lista', id: ids.campo, 'aria-describedby': ids.descr, onchange: function (e) { elegir(e.target.value); } },
        h('option', { value: '' }, 'Elige una opción'),
        opcionesDe_(p).map(function (o) { return h('option', { value: o }, o); }));
      sel.value = estado.resp[p.id] || '';
      return [sel, detalle];
    }
    var op = opcionesDe_(p);
    return [h('div', { class: 'opciones' + (op.length <= 3 ? ' en-fila' : ''), role: 'radiogroup', 'aria-labelledby': ids.etiqueta, 'aria-describedby': ids.descr },
      op.map(function (o) {
        return h('label', { class: 'opcion' },
          h('input', { type: 'radio', name: p.id, value: o, checked: estado.resp[p.id] === o, onchange: function () { elegir(o); } }),
          h('span', null, o));
      })), detalle];
  }

  function controlMultiple(p, ids) {
    var otro = etiquetaOtro_(p);
    var actual = estado.resp[p.id] || [];
    var detalle = otro ? campoOtro(p, actual.indexOf(otro) >= 0) : null;
    return [h('div', { class: 'opciones multiple', role: 'group', 'aria-labelledby': ids.etiqueta, 'aria-describedby': ids.descr },
      opcionesDe_(p).map(function (o) {
        return h('label', { class: 'opcion' },
          h('input', {
            type: 'checkbox', value: o, checked: actual.indexOf(o) >= 0,
            onchange: function (e) {
              var lista = (estado.resp[p.id] || []).filter(function (x) { return x !== o; });
              if (e.target.checked) lista.push(o);
              if (detalle && o === otro) {
                detalle.classList.toggle('oculto', !e.target.checked);
                if (e.target.checked) detalle.focus();
              }
              fijar(p, lista);
            }
          }),
          h('span', null, o));
      })), detalle];
  }

  function controlGps(p, ids) {
    var salida = h('div', { 'aria-live': 'polite' });
    var boton = h('button', { type: 'button', class: 'boton boton-ancho', id: ids.campo, 'aria-describedby': ids.descr, onclick: capturar }, icono(ICONOS.pin), 'Capturar ubicación');

    function mostrar() {
      salida.textContent = '';
      var v = estado.resp[p.id];
      if (!v) return;
      var limite = p.maxPrecisionM || 30;
      var buena = v.precision <= limite;
      boton.lastChild.textContent = 'Capturar de nuevo';
      salida.appendChild(h('p', { class: 'estado ' + (buena ? 'estado-ok' : 'estado-aviso') },
        (buena ? 'Ubicación capturada. ' : 'Ubicación poco precisa. Sal a cielo abierto y captúrala de nuevo si puedes. ') +
        v.lat + ', ' + v.lng + ' (±' + v.precision + ' m). ',
        h('a', { href: 'https://www.google.com/maps?q=' + Number(v.lat) + ',' + Number(v.lng), target: '_blank', rel: 'noopener noreferrer' }, 'Ver en el mapa')));
    }
    function capturar() {
      if (!navigator.geolocation) {
        salida.textContent = '';
        salida.appendChild(h('p', { class: 'estado estado-error' }, 'Este navegador no permite capturar la ubicación. Abre el enlace en Chrome o Safari.'));
        return;
      }
      // Se observa hasta 20 s y se conserva la mejor lectura: el primer dato del GPS suele ser el peor.
      var mejor = null, vigilante = null, reloj = null;
      boton.disabled = true;
      salida.textContent = '';
      salida.appendChild(h('p', { class: 'estado' }, 'Buscando señal GPS. Puede tardar hasta 20 segundos.'));
      function terminar() {
        navigator.geolocation.clearWatch(vigilante);
        clearTimeout(reloj);
        boton.disabled = false;
        if (mejor) {
          fijar(p, {
            lat: Number(mejor.latitude.toFixed(6)), lng: Number(mejor.longitude.toFixed(6)), precision: Math.round(mejor.accuracy),
            altitud: typeof mejor.altitude === 'number' && isFinite(mejor.altitude) ? Math.round(mejor.altitude * 10) / 10 : ''
          });
          mostrar();
        }
      }
      vigilante = navigator.geolocation.watchPosition(function (pos) {
        if (!mejor || pos.coords.accuracy < mejor.accuracy) mejor = pos.coords;
        if (mejor.accuracy <= 10) terminar();
      }, function (err) {
        if (mejor) { terminar(); return; }
        navigator.geolocation.clearWatch(vigilante);
        clearTimeout(reloj);
        boton.disabled = false;
        var textos = {
          1: 'El permiso de ubicación está bloqueado. Actívalo en los ajustes del navegador y captura de nuevo.',
          2: 'No hay señal GPS aquí. Sal a cielo abierto y captura de nuevo.',
          3: 'Se agotó el tiempo buscando señal. Sal a cielo abierto y captura de nuevo.'
        };
        salida.textContent = '';
        salida.appendChild(h('p', { class: 'estado estado-error' }, textos[err.code] || textos[2]));
      }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
      reloj = setTimeout(function () {
        if (mejor) { terminar(); return; }
        navigator.geolocation.clearWatch(vigilante);
        boton.disabled = false;
        salida.textContent = '';
        salida.appendChild(h('p', { class: 'estado estado-error' }, 'Se agotó el tiempo buscando señal. Sal a cielo abierto y captura de nuevo.'));
      }, 20000);
    }
    mostrar();
    return [boton, salida];
  }

  function controlFoto(p, ids) {
    var max = p.maxFotos || LIMITES_.maxFotosPorDefecto;
    var galeria = h('div', { class: 'miniaturas' });
    var aviso = h('div', { 'aria-live': 'polite' });
    var inputCamara = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'oculto', 'aria-hidden': 'true', tabindex: '-1', onchange: recibir });
    var inputGaleria = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'oculto', 'aria-hidden': 'true', tabindex: '-1', onchange: recibir });
    var botonCamara = h('button', { type: 'button', class: 'boton', id: ids.campo, 'aria-describedby': ids.descr, onclick: function () { inputCamara.click(); } }, icono(ICONOS.camara), 'Tomar foto');
    var botonGaleria = h('button', { type: 'button', class: 'boton', onclick: function () { inputGaleria.click(); } }, icono(ICONOS.galeria), 'Elegir de la galería');

    function pintar() {
      var fotos = estado.resp[p.id] || [];
      galeria.textContent = '';
      fotos.forEach(function (foto, i) {
        galeria.appendChild(h('div', { class: 'miniatura' },
          h('img', { src: 'data:image/jpeg;base64,' + foto.base64, alt: 'Foto ' + (i + 1) }),
          h('button', {
            type: 'button', class: 'quitar', 'aria-label': 'Quitar foto ' + (i + 1),
            onclick: function () {
              var lista = (estado.resp[p.id] || []).slice();
              lista.splice(i, 1);
              fijar(p, lista);
              pintar();
            }
          }, '×')));
      });
      var lleno = fotos.length >= max;
      botonCamara.disabled = botonGaleria.disabled = lleno;
      aviso.textContent = '';
      if (lleno) aviso.appendChild(h('p', { class: 'estado' }, 'Ya agregaste ' + max + (max === 1 ? ' foto, el máximo.' : ' fotos, el máximo.')));
    }
    function recibir(e) {
      var archivos = Array.prototype.slice.call(e.target.files || []);
      e.target.value = '';
      var cupo = max - (estado.resp[p.id] || []).length;
      var sobrantes = archivos.length - cupo;
      archivos = archivos.slice(0, Math.max(cupo, 0));
      if (!archivos.length) return;
      aviso.textContent = '';
      aviso.appendChild(h('p', { class: 'estado' }, 'Preparando foto…'));
      archivos.reduce(function (c, archivo) {
        return c.then(function () { return comprimirFoto(archivo); }).then(function (foto) {
          fijar(p, (estado.resp[p.id] || []).concat([foto]));
        });
      }, Promise.resolve()).then(function () {
        pintar();
        if (sobrantes > 0) aviso.appendChild(h('p', { class: 'estado estado-aviso' }, 'Solo se agregaron las primeras: el máximo es ' + max + '.'));
      }).catch(function () {
        pintar();
        aviso.appendChild(h('p', { class: 'estado estado-error' }, 'Este formato de foto no se pudo abrir. Toma la foto con el botón "Tomar foto" o elige otra.'));
      });
    }
    pintar();
    return [h('div', { class: 'dos-botones' }, botonCamara, botonGaleria), inputCamara, inputGaleria, galeria, aviso];
  }

  function controlMatriz(p, ids) {
    return h('div', { class: 'materiales', role: 'group', 'aria-labelledby': ids.etiqueta },
      p.filas.map(function (f) {
        return h('div', { class: 'material' },
          h('p', { class: 'material-nombre', id: ids.campo + '-' + f.id }, f.etiqueta),
          h('div', { class: 'material-campos' }, p.columnas.map(function (c) {
            var idCampo = ids.campo + '-' + f.id + '-' + c.id;
            var actual = (estado.resp[p.id] || {})[f.id] || {};
            return h('div', null,
              h('label', { for: idCampo }, c.etiqueta),
              h('input', {
                id: idCampo, class: 'entrada', type: 'text', inputmode: 'decimal', autocomplete: 'off',
                'aria-label': f.etiqueta + ', ' + c.etiqueta, value: actual[c.id] === undefined ? '' : actual[c.id],
                oninput: function (e) {
                  var m = estado.resp[p.id] = estado.resp[p.id] || {};
                  m[f.id] = m[f.id] || {};
                  m[f.id][c.id] = e.target.value;
                  alCambiar(p);
                }
              }));
          })));
      }));
  }

  // Código de registro "REG-xxxxxxxx": se genera solo, una vez por encuesta, y no se edita.
  function codigoRegistro() {
    var b = crypto.getRandomValues(new Uint8Array(4));
    return 'REG-' + Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function controlEntrada(p, ids) {
    if (p.automatico === 'registro' && !estado.resp[p.id]) estado.resp[p.id] = codigoRegistro();
    var comun = {
      id: ids.campo, class: 'entrada', 'aria-describedby': ids.descr, autocomplete: 'off',
      value: estado.resp[p.id] === undefined ? '' : estado.resp[p.id],
      oninput: function (e) { fijar(p, e.target.value); }
    };
    if (p.automatico) { comun.readonly = true; comun.tabindex = '-1'; }
    if (p.tipo === 'parrafo') return h('textarea', comun);
    var extra = {
      texto: { type: 'text' }, fecha: { type: 'date' }, correo: { type: 'email', inputmode: 'email' },
      telefono: { type: 'tel', inputmode: 'tel' },
      numero: { type: 'text', inputmode: 'decimal' }, entero: { type: 'text', inputmode: 'numeric' }
    }[p.tipo];
    Object.keys(extra).forEach(function (k) { comun[k] = extra[k]; });
    return h('input', comun);
  }

  function preguntaEl(p) {
    var ids = { campo: 'c-' + p.id, etiqueta: 'e-' + p.id, descr: 'd-' + p.id };
    var conjunto = p.tipo === 'matriz' || p.tipo === 'multiple' || (p.tipo === 'seleccion' && controlDe_(p) === 'botones');
    var etiqueta = h(conjunto ? 'div' : 'label', { class: 'etiqueta', id: ids.etiqueta, for: conjunto ? null : ids.campo },
      numeros[p.id] + '. ' + p.etiqueta, p.requerida && !enc.sinValidacion ? h('span', { class: 'obligatoria', title: 'Obligatoria' }, ' *') : null);
    var ayuda = !p.ayuda ? null : p.ayudaOculta === true
      ? h('details', { class: 'ayuda-plegable', id: ids.descr }, h('summary', null, 'Ver ayuda'), h('p', { class: 'ayuda' }, p.ayuda))
      : h('p', { class: 'ayuda', id: ids.descr }, p.ayuda);
    var error = h('p', { class: 'msg-error oculto', id: ids.descr + '-error', role: 'alert' });
    var control;
    if (p.tipo === 'seleccion') control = controlSeleccion(p, ids);
    else if (p.tipo === 'multiple') control = controlMultiple(p, ids);
    else if (p.tipo === 'gps') control = controlGps(p, ids);
    else if (p.tipo === 'foto') control = controlFoto(p, ids);
    else if (p.tipo === 'matriz') control = controlMatriz(p, ids);
    else control = controlEntrada(p, ids);
    var envoltura = h('div', { class: 'pregunta', id: 'p-' + p.id }, etiqueta, ayuda, control, error);
    nodos[p.id] = { envoltura: envoltura, error: error };
    pintarError(p);
    return envoltura;
  }

  // Una pantalla sin ninguna pregunta visible (por ejemplo, la de lavado en un registro de zona verde)
  // no se muestra: se salta al avanzar, al retroceder y en la barra de pasos.
  function seccionConPreguntas(i) {
    if (i >= secciones.length) return true;
    var vistos = vistosActuales();
    return secciones[i].preguntas.some(function (p) { return Object.prototype.hasOwnProperty.call(vistos, p.id); });
  }
  function pasoVecino(delta) {
    var i = estado.paso + delta;
    while (i > 0 && i < secciones.length && !seccionConPreguntas(i)) i += delta;
    return i;
  }
  function rutaDePasos() {
    var lista = [];
    for (var i = 0; i <= secciones.length; i++) if (seccionConPreguntas(i)) lista.push(i);
    return lista;
  }

  function vistosActuales() {
    var vistos = {};
    preguntasDe_(enc).forEach(function (p) {
      if (esVisible_(p, vistos)) vistos[p.id] = estado.resp[p.id];
    });
    return vistos;
  }
  function actualizarVisibles() {
    var vistos = vistosActuales();
    Object.keys(nodos).forEach(function (id) {
      nodos[id].envoltura.classList.toggle('oculto', !Object.prototype.hasOwnProperty.call(vistos, id));
    });
  }

  // ---------- Pantallas ----------
  // Solo se acepta una imagen incrustada (webp o png); cualquier otra dirección se ignora.
  function logoUrlSeguro() {
    return typeof enc.logoUrl === 'string' && /^data:image\/(webp|png);base64,[A-Za-z0-9+\/=]+$/.test(enc.logoUrl);
  }

  function cabecera(titulo) {
    var pasos = rutaDePasos();
    var total = pasos.length;
    var conRuta = estado.paso <= secciones.length;
    var posicion = pasos.indexOf(estado.paso) + 1;
    return h('header', { class: 'cabecera' },
      h('div', { class: 'cabecera-interior' },
        // Salida a la lista de encuestas desde cualquier pantalla: lo escrito queda en el borrador de esta encuesta.
        conRuta && typeof PANEL_URL === 'string' && PANEL_URL
          ? h('a', { class: 'volver-panel', href: PANEL_URL }, '← Elegir otra encuesta') : null,
        h('div', { class: 'cabecera-titulos' },
          logoUrlSeguro() ? h('img', { class: 'logo', src: enc.logoUrl, alt: 'Consorcio Zaragoza 2026', width: '420', height: '234' }) : null,
          h('div', { class: 'cabecera-texto' },
            h('p', { class: 'encuesta-nombre' }, enc.titulo),
            h('h1', { class: 'paso-titulo', tabindex: '-1', id: 'titulo-paso' }, titulo))),
        conRuta ? h('ol', { class: 'ruta', 'aria-label': 'Paso ' + posicion + ' de ' + total },
          pasos.map(function (i, k) {
            var nombre = i < secciones.length ? secciones[i].titulo : 'Revisar y guardar';
            return h('li', { class: i < estado.paso ? 'hecho' : (i === estado.paso ? 'actual' : '') },
              h('button', {
                type: 'button', class: 'parada', disabled: i > estado.maxPaso || i === estado.paso,
                'aria-label': 'Paso ' + (k + 1) + ': ' + nombre, 'aria-current': i === estado.paso ? 'step' : null,
                onclick: function () { irA(i); }
              }));
          })) : null));
  }

  function montar(partes, foco) {
    raiz.textContent = '';
    agregar(raiz, partes);
    window.scrollTo(0, 0);
    pintarAvisoCola();
    if (foco) { var t = document.getElementById('titulo-paso'); if (t) t.focus({ preventScroll: true }); }
  }

  function irA(i) {
    estado.paso = i;
    estado.maxPaso = Math.max(estado.maxPaso, i);
    guardarBorrador();
    pintar(true);
  }

  function erroresDeSeccion(seccion) {
    var r = validarRespuestas_(enc, estado.resp);
    var ids = seccion.preguntas.map(function (p) { return p.id; });
    var errores = {};
    Object.keys(r.errores).forEach(function (id) {
      if (ids.indexOf(id) >= 0) errores[id] = r.errores[id];
    });
    return errores;
  }

  function enfocarPrimerError() {
    var primero = document.querySelector('.invalida');
    if (!primero) return;
    primero.scrollIntoView({ block: 'center' });
    var control = primero.querySelector('input:not(.oculto), select, textarea, button');
    if (control) control.focus({ preventScroll: true });
  }

  function pantallaSeccion() {
    var s = secciones[estado.paso];
    var cuerpo = s.preguntas.map(preguntaEl);
    var form = h('form', {
      novalidate: true,
      onsubmit: function (e) {
        e.preventDefault();
        var errores = erroresDeSeccion(s);
        estado.errores = errores;
        s.preguntas.forEach(pintarError);
        if (Object.keys(errores).length) { enfocarPrimerError(); return; }
        irA(pasoVecino(1));
      }
    },
      h('main', { class: 'contenido entra' }, estado.paso === 0 ? botonInstalar() : null, s.ayuda ? h('p', { class: 'seccion-ayuda' }, s.ayuda) : null, cuerpo),
      barra(estado.paso > 0 ? h('button', { type: 'button', class: 'boton', onclick: function () { irA(pasoVecino(-1)); } }, 'Atrás') : null,
        h('button', { type: 'submit', class: 'boton boton-principal' }, 'Siguiente')));
    return [avisoCola(), cabecera(s.titulo), form];
  }

  function barra(atras, principal) {
    return h('div', { class: 'barra' }, h('div', { class: 'barra-interior' + (atras ? '' : ' sola') }, atras, principal));
  }

  function textoRespuesta(p, limpio) {
    var v = limpio[p.id];
    if (v === undefined) return null;
    if (p.tipo === 'gps') return v.lat + ', ' + v.lng + ' (±' + v.precision + ' m)';
    if (p.tipo === 'foto') return v.length === 1 ? '1 foto' : v.length + ' fotos';
    if (p.tipo === 'multiple') return v.join('\n');
    if (p.tipo === 'matriz') {
      return p.filas.filter(function (f) { return v[f.id]; }).map(function (f) {
        return f.etiqueta + ': ' + p.columnas.filter(function (c) { return v[f.id][c.id] !== undefined; })
          .map(function (c) { return c.etiqueta.toLowerCase() + ' ' + v[f.id][c.id]; }).join(', ');
      }).join('\n');
    }
    return String(v);
  }

  function pantallaRevisar() {
    var r = validarRespuestas_(enc, estado.resp);
    var vistos = vistosActuales();
    var trampa = h('div', { class: 'trampa', 'aria-hidden': 'true' },
      h('label', null, 'Sitio web', h('input', { type: 'text', id: 'sitio', tabindex: '-1', autocomplete: 'off' })));
    var msg = h('div', { 'aria-live': 'assertive' });
    var dp = enc.datosPersonales && !enc.datosPersonales.sinDatosPersonales ? enc.datosPersonales : null;
    var enviar = h('button', { type: 'submit', class: 'boton boton-principal' }, 'Guardar encuesta');

    var resumen = secciones.map(function (s, i) {
      var visibles = s.preguntas.filter(function (p) { return Object.prototype.hasOwnProperty.call(vistos, p.id); });
      return h('section', { class: 'resumen-seccion' },
        h('div', { class: 'resumen-titulo' },
          h('h2', null, s.titulo),
          h('button', { type: 'button', class: 'boton-texto', 'aria-label': 'Editar ' + s.titulo, onclick: function () { irA(i); } }, 'Editar')),
        h('dl', { class: 'resumen-lista' }, visibles.map(function (p) {
          var t = textoRespuesta(p, r.limpio);
          return h('div', null, h('dt', null, numeros[p.id] + '. ' + p.etiqueta),
            h('dd', { class: t === null ? 'sin-respuesta' : null }, t === null ? 'Sin respuesta' : t));
        })));
    });

    var autorizacion = dp ? h('div', { class: 'autorizacion' },
      h('p', { style: 'margin:0' }, dp.responsable + ' tratará estos datos para ' + dp.finalidad + '. La persona encuestada puede conocerlos, actualizarlos o pedir que se eliminen (Ley 1581 de 2012).'),
      h('label', null,
        h('input', { type: 'checkbox', id: 'autoriza', checked: estado.autorizacion, onchange: function (e) { estado.autorizacion = e.target.checked; } }),
        h('span', null, 'La persona encuestada autoriza el tratamiento de sus datos.'))) : null;

    var form = h('form', {
      novalidate: true,
      onsubmit: function (e) {
        e.preventDefault();
        msg.textContent = '';
        var v = validarRespuestas_(enc, estado.resp);
        if (!v.ok) {
          var primero = Object.keys(v.errores)[0];
          secciones.some(function (s, i) {
            if (!s.preguntas.some(function (p) { return p.id === primero; })) return false;
            estado.errores = v.errores;
            irA(i);
            enfocarPrimerError();
            return true;
          });
          return;
        }
        if (dp && !estado.autorizacion) {
          msg.appendChild(h('p', { class: 'estado estado-error' }, 'Marca la autorización de datos para guardar la encuesta.'));
          return;
        }
        enviarEncuesta(enviar, msg, document.getElementById('sitio').value);
      }
    },
      h('main', { class: 'contenido entra' }, resumen, autorizacion, trampa, msg),
      barra(h('button', { type: 'button', class: 'boton', onclick: function () { irA(pasoVecino(-1)); } }, 'Atrás'), enviar));
    return [avisoCola(), cabecera('Revisa y guarda'), form];
  }

  function enviarEncuesta(boton, msg, sitio) {
    boton.disabled = true;
    boton.textContent = 'Guardando…';
    var envio, clave;
    envio = {
      encuestaId: enc.id, envioId: nuevoId(), codigo: estado.codigo, sitio: sitio,
      autorizacion: !!estado.autorizacion, respuestas: estado.resp
    };
    clave = prefijoCola + envio.envioId;
    // Primero se guarda en el celular y luego se envía: si se cae la señal no se pierde.
    almacen.poner(clave, envio).then(function () {
      enviandoCola = true;
      return llamar('enviarRespuesta', envio);
    }).then(function (r) {
      enviandoCola = false;
      if (r.ok) {
        return almacen.borrar(clave).then(function () { terminar(false); });
      }
      if (r.reintentar) { estado.etapa = r.etapa || ''; terminar(true); return; }
      return almacen.borrar(clave).then(function () {
        boton.disabled = false;
        boton.textContent = 'Guardar encuesta';
        if (r.codigoInvalido) {
          // Las respuestas siguen en memoria: al entrar con el código nuevo se vuelve a esta pantalla.
          estado.codigo = '';
          pintar(true);
          return;
        }
        if (r.errores) {
          estado.errores = r.errores;
          var primero = Object.keys(r.errores)[0];
          secciones.some(function (s, i) {
            if (!s.preguntas.some(function (p) { return p.id === primero; })) return false;
            irA(i);
            enfocarPrimerError();
            return true;
          });
          return;
        }
        msg.appendChild(h('p', { class: 'estado estado-error' }, r.mensaje));
      });
    }).catch(function () {
      enviandoCola = false;
      terminar(true);
    });
  }

  function terminar(enCola) {
    var recordar = {};
    preguntasDe_(enc).forEach(function (p) {
      if (p.recordar && estado.resp[p.id]) recordar[p.id] = estado.resp[p.id];
    });
    almacen.poner(claveRecordar, recordar);
    almacen.borrar(claveBorrador);
    clearTimeout(temporizadorBorrador);
    estado.paso = secciones.length + 1;
    estado.enCola = enCola;
    pintar(true);
    contarPendientes();
  }

  function pantallaFinal() {
    return [avisoCola(), cabecera(enc.subtitulo || enc.titulo),
      h('main', { class: 'contenido final entra' },
        h('h2', null, estado.enCola ? 'Encuesta guardada en este celular' : 'Encuesta enviada'),
        h('p', null, estado.enCola
          ? 'No se pudo enviar ahora. Se enviará sola cuando vuelva la señal. Si cierras esta página, abre de nuevo el enlace con señal para enviarla.' + (estado.etapa ? ' Código de la falla: ' + estado.etapa + '.' : '')
          : 'Las respuestas y las fotos ya quedaron en la hoja de la encuesta.'),
        h('button', {
          type: 'button', class: 'boton boton-principal boton-ancho',
          onclick: function () {
            Promise.all([almacen.leer(claveRecordar), almacen.leer(clavePerfil)]).then(function (d) {
              estado.resp = iniciales(d[0] || {}, d[1] || {});
              estado.autorizacion = false;
              estado.errores = {};
              estado.paso = 0;
              estado.maxPaso = 0;
              pintar(true);
            });
          }
        }, 'Iniciar otra encuesta'),
        // El panel lista todas las encuestas: aquí se vuelve a él para elegir otra.
        typeof PANEL_URL === 'string' && PANEL_URL ? h('p', { class: 'enlace-panel' }, h('a', { href: PANEL_URL }, 'Elegir otra encuesta')) : null)];
  }

  function pantallaCodigo() {
    var entrada = h('input', { id: 'codigo', class: 'entrada', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' });
    var msg = h('div', { 'aria-live': 'assertive' });
    var boton = h('button', { type: 'submit', class: 'boton boton-principal boton-ancho' }, 'Entrar');
    return [cabeceraSimple(), h('main', { class: 'contenido entra' },
      h('form', {
        novalidate: true,
        onsubmit: function (e) {
          e.preventDefault();
          msg.textContent = '';
          boton.disabled = true;
          llamar('verificarCodigo', { encuestaId: enc.id, codigo: entrada.value }).then(function (r) {
            boton.disabled = false;
            if (r.ok) { estado.codigo = entrada.value.trim().toUpperCase(); pintar(true); return; }
            msg.appendChild(h('p', { class: 'estado estado-error' }, r.mensaje));
          }).catch(function () {
            boton.disabled = false;
            msg.appendChild(h('p', { class: 'estado estado-error' }, 'Sin conexión. Busca señal e intenta de nuevo.'));
          });
        }
      },
        h('div', { class: 'pregunta' }, h('label', { class: 'etiqueta', for: 'codigo' }, 'Código de acceso'), entrada, msg),
        boton))];
  }
  function cabeceraSimple() {
    return h('header', { class: 'cabecera' }, h('div', { class: 'cabecera-interior' },
      h('p', { class: 'encuesta-nombre' }, enc.subtitulo || ''),
      h('h1', { class: 'paso-titulo', tabindex: '-1', id: 'titulo-paso' }, enc.titulo)));
  }

  function pintar(foco) {
    // Se limpia antes de armar la pantalla: cada pregunta se registra aquí al crearse.
    nodos = {};
    if (enc.acceso.tipo === 'codigo' && !estado.codigo) { montar(pantallaCodigo(), foco); return; }
    if (estado.paso > secciones.length) { montar(pantallaFinal(), foco); return; }
    if (estado.paso === secciones.length) { montar(pantallaRevisar(), foco); return; }
    montar(pantallaSeccion(), foco);
    actualizarVisibles();
  }

  // El perfil (Mis datos del panel) manda sobre lo recordado: si la persona cambia su nombre, gana el nuevo.
  function iniciales(recordado, perfil) {
    var resp = {};
    preguntasDe_(enc).forEach(function (p) {
      if (recordado[p.id] !== undefined) resp[p.id] = recordado[p.id];
      if (p.perfil && perfil && perfil[p.perfil]) resp[p.id] = perfil[p.perfil];
      if (p.porDefecto === 'hoy') {
        var d = new Date();
        resp[p.id] = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      }
    });
    return resp;
  }

  // ---------- Arranque ----------
  // Pide al navegador que no borre el borrador ni la cola cuando necesite espacio.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  Promise.all([almacen.leer(claveBorrador), almacen.leer(claveRecordar), almacen.leer(clavePerfil)]).then(function (d) {
    var borrador = d[0], recordado = d[1] || {}, perfil = d[2] || {};
    if (borrador && borrador.resp) {
      estado.resp = borrador.resp;
      estado.paso = Math.min(borrador.paso || 0, secciones.length);
      estado.maxPaso = Math.min(borrador.maxPaso || 0, secciones.length);
      // Un borrador de antes de guardar "Mis datos" se completa con ellos, sin pisar lo escrito.
      preguntasDe_(enc).forEach(function (p) {
        if (p.perfil && perfil[p.perfil] && !estado.resp[p.id]) estado.resp[p.id] = perfil[p.perfil];
      });
    } else {
      estado.resp = iniciales(recordado, perfil);
    }
    pintar(false);
    vaciarCola();
  }, function () {
    estado.resp = iniciales({}, null);
    pintar(false);
  });
})();
