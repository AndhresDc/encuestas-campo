// Validación compartida. Este mismo archivo corre en el celular (para avisar rápido)
// y en el servidor (la que manda: nunca se confía en lo que envía el navegador).

var LIMITES_ = {
  texto: 300,
  parrafo: 2000,
  otro: 120,
  fotoBytes: 2.5 * 1024 * 1024,
  digitosNumero: 20,
  maxFotosPorDefecto: 3,
  libreTexto: 2000,
  libreParrafo: 10000
};

function preguntasDe_(encuesta) {
  var lista = [];
  encuesta.secciones.forEach(function (s) {
    s.preguntas.forEach(function (p) { lista.push(p); });
  });
  return lista;
}

function etiquetaOtro_(p) {
  if (!p.otro) return null;
  return typeof p.otro === 'string' ? p.otro : 'Otro';
}

function opcionesDe_(p) {
  var op = (p.opciones || []).slice();
  var otro = etiquetaOtro_(p);
  if (otro) op.push(otro);
  return op;
}

function controlDe_(p) {
  if (p.control) return p.control;
  return opcionesDe_(p).length >= 4 ? 'lista' : 'botones';
}

function esVisible_(p, vistos) {
  if (!p.mostrarSi) return true;
  var v = vistos[p.mostrarSi.pregunta];
  var esperado = [].concat(p.mostrarSi.es);
  if (Array.isArray(v)) return v.some(function (x) { return esperado.indexOf(x) >= 0; });
  return esperado.indexOf(v) >= 0;
}

function limpiarTexto_(v, multilinea) {
  if (v !== null && typeof v === 'object') return '';
  var s = String(v === null || v === undefined ? '' : v);
  if (s.normalize) s = s.normalize('NFC');
  s = multilinea ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  return s.trim();
}

function aNumero_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  var s = limpiarTexto_(v).replace(/\s/g, '').replace(',', '.');
  if (s.length > LIMITES_.digitosNumero || !/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

function fechaValida_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Encuesta con "sinValidacion": se guarda lo escrito tal cual (el número, si se puede leer
// como número). Solo se recorta a un tope técnico para no llenar la hoja de Google.
function valorLibre_(v, multilinea) {
  var t = limpiarTexto_(v, multilinea);
  var tope = multilinea ? LIMITES_.libreParrafo : LIMITES_.libreTexto;
  return t.length > tope ? t.slice(0, tope) : t;
}

function valorLibreNumero_(v) {
  var n = aNumero_(v);
  return isNaN(n) ? valorLibre_(v) : n;
}

function validarNumero_(p, v, soloEnteros) {
  var n = aNumero_(v);
  if (isNaN(n)) return { error: soloEnteros ? 'Escribe un número entero, sin puntos ni letras.' : 'Escribe un número. Usa coma o punto para los decimales.' };
  if (soloEnteros && Math.floor(n) !== n) return { error: 'Escribe un número entero, sin decimales.' };
  var min = p.min === undefined ? 0 : p.min;
  if (n < min) return { error: 'El valor mínimo es ' + min + '.' };
  if (p.max !== undefined && n > p.max) return { error: 'El valor máximo es ' + p.max + '.' };
  return { valor: n };
}

function validarSeleccion_(p, v, resp, libre) {
  var op = opcionesDe_(p);
  var s = limpiarTexto_(v);
  if (op.indexOf(s) < 0) return { error: 'Elige una opción de la lista.' };
  if (s === etiquetaOtro_(p)) {
    var detalle = limpiarTexto_(resp[p.id + '__otro']);
    if (libre) return { valor: detalle ? s + ': ' + detalle.slice(0, LIMITES_.otro) : s };
    if (!detalle) return { error: 'Escribe cuál en el espacio de abajo.' };
    if (detalle.length > LIMITES_.otro) return { error: 'Usa máximo ' + LIMITES_.otro + ' caracteres.' };
    return { valor: s + ': ' + detalle };
  }
  return { valor: s };
}

function validarMultiple_(p, v, resp, libre) {
  if (!Array.isArray(v)) return { error: 'Elige al menos una opción.' };
  var op = opcionesDe_(p);
  var salida = [];
  var otro = etiquetaOtro_(p);
  for (var i = 0; i < v.length; i++) {
    var s = limpiarTexto_(v[i]);
    if (op.indexOf(s) < 0) return { error: 'Hay una opción que no está en la lista.' };
    if (salida.indexOf(s) >= 0) continue;
    if (s === otro) {
      var detalle = limpiarTexto_(resp[p.id + '__otro']);
      if (libre) { salida.push(detalle ? s + ': ' + detalle.slice(0, LIMITES_.otro) : s); continue; }
      if (!detalle) return { error: 'Escribe cuál en el espacio de abajo.' };
      if (detalle.length > LIMITES_.otro) return { error: 'Usa máximo ' + LIMITES_.otro + ' caracteres.' };
      salida.push(s + ': ' + detalle);
    } else {
      salida.push(s);
    }
  }
  return { valor: salida };
}

function validarGps_(v) {
  if (!v || typeof v !== 'object') return { error: 'Captura la ubicación.' };
  var lat = Number(v.lat), lng = Number(v.lng), precision = Number(v.precision);
  var altitud = v.altitud === '' || v.altitud === null || v.altitud === undefined ? NaN : Number(v.altitud);
  if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { error: 'La ubicación capturada no es válida. Captúrala de nuevo.' };
  }
  return {
    valor: {
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      precision: isFinite(precision) && precision >= 0 ? Math.round(precision) : '',
      altitud: isFinite(altitud) && Math.abs(altitud) < 100000 ? Math.round(altitud * 10) / 10 : ''
    }
  };
}

function validarFotos_(p, v) {
  if (!Array.isArray(v)) return { error: 'Agrega una foto.' };
  var max = p.maxFotos || LIMITES_.maxFotosPorDefecto;
  if (v.length > max) return { error: 'Puedes agregar máximo ' + max + ' fotos.' };
  var salida = [];
  for (var i = 0; i < v.length; i++) {
    var b64 = v[i] && v[i].base64;
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'Una foto llegó dañada. Quítala y agrégala de nuevo.' };
    if (b64.length * 3 / 4 > LIMITES_.fotoBytes) return { error: 'Una foto pesa demasiado. Quítala y agrégala de nuevo.' };
    salida.push({ base64: b64 });
  }
  return { valor: salida };
}

function validarMatriz_(p, v, libre) {
  var limpio = {};
  var hayDatos = false;
  var fuente = v && typeof v === 'object' ? v : {};
  for (var f = 0; f < p.filas.length; f++) {
    var fila = p.filas[f];
    var entrada = Object.prototype.hasOwnProperty.call(fuente, fila.id) ? fuente[fila.id] : null;
    if (!entrada || typeof entrada !== 'object') continue;
    for (var c = 0; c < p.columnas.length; c++) {
      var col = p.columnas[c];
      var bruto = Object.prototype.hasOwnProperty.call(entrada, col.id) ? entrada[col.id] : '';
      if (limpiarTexto_(bruto) === '') continue;
      var r = libre ? { valor: valorLibreNumero_(bruto) } : validarNumero_(col, bruto, false);
      if (r.error) return { error: fila.etiqueta + ', ' + col.etiqueta.toLowerCase() + ': ' + r.error };
      limpio[fila.id] = limpio[fila.id] || {};
      limpio[fila.id][col.id] = r.valor;
      hayDatos = true;
    }
  }
  return hayDatos ? { valor: limpio } : { vacio: true };
}

function validarValor_(p, v, resp, libre) {
  var vacio = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  if (p.tipo === 'matriz') return validarMatriz_(p, v, libre);
  if (vacio) return { vacio: true };
  if (libre) {
    switch (p.tipo) {
      case 'texto':
      case 'telefono':
      case 'correo':
      case 'fecha':
        var corto = valorLibre_(v);
        return corto ? { valor: corto } : { vacio: true };
      case 'parrafo':
        var largo = valorLibre_(v, true);
        return largo ? { valor: largo } : { vacio: true };
      case 'numero':
      case 'entero':
        var num = valorLibreNumero_(v);
        return num === '' ? { vacio: true } : { valor: num };
    }
  }
  switch (p.tipo) {
    case 'texto':
    case 'parrafo':
      var multilinea = p.tipo === 'parrafo';
      var t = limpiarTexto_(v, multilinea);
      if (!t) return { vacio: true };
      var max = p.maxLargo || (multilinea ? LIMITES_.parrafo : LIMITES_.texto);
      if (t.length > max) return { error: 'Usa máximo ' + max + ' caracteres.' };
      return { valor: t };
    case 'numero': return validarNumero_(p, v, false);
    case 'entero': return validarNumero_(p, v, true);
    case 'telefono':
      var tel = limpiarTexto_(v).replace(/[\s()-]/g, '');
      if (!/^\+?\d{7,15}$/.test(tel)) return { error: 'Escribe un teléfono de 7 a 15 dígitos.' };
      return { valor: tel };
    case 'correo':
      var c = limpiarTexto_(v);
      if (c.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return { error: 'Escribe un correo como nombre@dominio.com.' };
      return { valor: c };
    case 'fecha':
      var f = limpiarTexto_(v);
      if (!fechaValida_(f)) return { error: 'Elige una fecha válida.' };
      return { valor: f };
    case 'seleccion': return validarSeleccion_(p, v, resp, libre);
    case 'multiple': return validarMultiple_(p, v, resp, libre);
    case 'gps': return validarGps_(v);
    case 'foto': return validarFotos_(p, v);
    default: return { error: 'Tipo de pregunta desconocido.' };
  }
}

// Solo pasa lo que el esquema conoce: cualquier campo extra se descarta aquí.
function validarRespuestas_(encuesta, respuestas) {
  var resp = respuestas && typeof respuestas === 'object' ? respuestas : {};
  var limpio = {};
  var errores = {};
  var vistos = {};
  var libre = encuesta.sinValidacion === true;

  preguntasDe_(encuesta).forEach(function (p) {
    if (!esVisible_(p, vistos)) return;
    var bruto = Object.prototype.hasOwnProperty.call(resp, p.id) ? resp[p.id] : undefined;
    vistos[p.id] = bruto;
    var r = validarValor_(p, bruto, resp, libre);
    if (r.error) {
      errores[p.id] = r.error;
    } else if (r.vacio) {
      if (p.requerida && !libre) errores[p.id] = mensajeRequerida_(p);
    } else {
      limpio[p.id] = r.valor;
    }
  });

  (libre ? [] : (encuesta.reglas || [])).forEach(function (regla) {
    if (regla.tipo !== 'noMayorQue' || limpio[regla.b] === undefined) return;
    var suma = 0, alguna = false;
    regla.a.forEach(function (id) {
      if (typeof limpio[id] === 'number') { suma += limpio[id]; alguna = true; }
    });
    var destino = regla.a[regla.a.length - 1];
    if (alguna && suma > limpio[regla.b] && !errores[destino]) errores[destino] = regla.mensaje;
  });

  return { ok: Object.keys(errores).length === 0, limpio: limpio, errores: errores };
}

function mensajeRequerida_(p) {
  switch (p.tipo) {
    case 'gps': return 'Captura la ubicación para continuar.';
    case 'foto': return 'Agrega al menos una foto.';
    case 'seleccion': return 'Elige una opción.';
    case 'multiple': return 'Elige al menos una opción.';
    default: return 'Completa este dato.';
  }
}
