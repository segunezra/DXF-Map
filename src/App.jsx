import React, { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  FileImage,
  LocateFixed,
  Map as MapIcon,
  MapPinned,
  PanelLeftClose,
  PanelLeftOpen,
  Satellite,
  Trash2,
  Upload,
} from 'lucide-react'

function isGeoTiff(file) {
  return /\.(tif|tiff)$/i.test(file.name) || ['image/tiff', 'image/geotiff'].includes(file.type)
}

function isDxf(file) {
  return /\.dxf$/i.test(file.name)
}

function isSupportedImage(file) {
  return /\.(png|jpe?g|gif|bmp)$/i.test(file.name)
}

function imageStem(file) {
  return file.name.replace(/\.[^.]+$/, '').toLowerCase()
}

function isWorldFile(file) {
  return /\.(pgw|pngw|jgw|jpgw|jpegw|gfw|gifw|bpw|bmpw|wld)$/i.test(file.name)
}

function readWorldFile(text, width, height) {
  const [pixelWidth, rotationY, rotationX, pixelHeight, centerX, centerY] = text
    .trim()
    .split(/\s+/)
    .map(Number)

  if ([pixelWidth, rotationY, rotationX, pixelHeight, centerX, centerY].some((value) => !Number.isFinite(value))) {
    throw new Error('The world file must contain six numeric coordinate values.')
  }
  if (Math.abs(rotationX) > 1e-12 || Math.abs(rotationY) > 1e-12 || pixelWidth <= 0 || pixelHeight >= 0) {
    throw new Error('This image uses a rotated or flipped world file. North-up images are required.')
  }

  const west = centerX - pixelWidth / 2
  const north = centerY - pixelHeight / 2
  const east = west + pixelWidth * width
  const south = north + pixelHeight * height

  if (west < -180 || east > 180 || south < -90 || north > 90 || east <= west || north <= south) {
    throw new Error('World-file coordinates must be longitude/latitude in WGS 84 (EPSG:4326).')
  }

  return L.latLngBounds([south, west], [north, east])
}

function formatFileSize(bytes) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function App() {
  const mapElement = useRef(null)
  const mapInstance = useRef(null)
  const basemapLayers = useRef({})
  const rasterLayer = useRef(null)
  const fileInput = useRef(null)
  const [basemap, setBasemap] = useState('streets')
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false)
  const [sourceFile, setSourceFile] = useState(null)
  const [worldFile, setWorldFile] = useState(null)
  const [rasterInfo, setRasterInfo] = useState(null)
  const [importState, setImportState] = useState('idle')
  const [importMessage, setImportMessage] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  useEffect(() => {
    const map = L.map(mapElement.current, { zoomControl: false, preferCanvas: true })
      .setView([20, 0], 2)

    const rasterPane = map.createPane('rasterPane')
    rasterPane.style.zIndex = '410'
    rasterPane.style.mixBlendMode = 'multiply'
    map.createPane('vectorPane').style.zIndex = '420'

    const streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    })
    const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    })
    basemapLayers.current = { streets, satellite }
    streets.addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    mapInstance.current = map

    return () => {
      map.remove()
      mapInstance.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapInstance.current
    if (!map) return undefined

    const frame = requestAnimationFrame(() => map.invalidateSize({ pan: false }))
    return () => cancelAnimationFrame(frame)
  }, [isPanelCollapsed])

  useEffect(() => {
    const map = mapInstance.current
    if (!map || !sourceFile) return undefined

    let cancelled = false
    let layer
    setImportState('loading')
    setImportMessage(isDxf(sourceFile) ? 'Converting DXF to WGS 84 GeoJSON…' : 'Reading embedded georeferencing…')
    setRasterInfo(null)

    let imageUrl

    async function addOverlay() {
      try {
        let bounds
        let crs

        if (isDxf(sourceFile)) {
          const formData = new FormData()
          formData.append('file', sourceFile)
          const response = await fetch('/api/convert-dxf', { method: 'POST', body: formData })
          const featureCollection = await response.json().catch(() => null)
          if (!response.ok) {
            throw new Error(featureCollection?.detail || 'The DXF conversion failed.')
          }
          if (featureCollection?.type !== 'FeatureCollection' || !Array.isArray(featureCollection.features)) {
            throw new Error('The backend returned invalid GeoJSON.')
          }

          layer = L.geoJSON(featureCollection, {
            style: { color: '#ff7138', weight: 2, opacity: 0.95, fillColor: '#f5c451', fillOpacity: 0.22, pane: 'vectorPane' },
            pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
              pane: 'vectorPane',
              radius: 5,
              color: '#ff7138',
              weight: 1.5,
              fillColor: '#f5c451',
              fillOpacity: 0.9,
            }),
          })
          bounds = layer.getBounds()
          crs = 'EPSG:4326'
        } else if (isGeoTiff(sourceFile)) {
          const [{ default: parseGeoraster }, { default: GeoRasterLayer }] = await Promise.all([
            import('georaster'),
            import('georaster-layer-for-leaflet'),
          ])
          const georaster = await parseGeoraster(sourceFile, { readOnDemand: true })
          if (cancelled) return
          layer = new GeoRasterLayer({ georaster, opacity: 0.9, resolution: 256, pane: 'rasterPane' })
          bounds = layer.getBounds()
          crs = georaster.projection ? `EPSG:${georaster.projection}` : 'CRS unavailable'
        } else {
          if (!worldFile) {
            throw new Error('Add the matching world file too (for example, map.png and map.pgw) to locate this image.')
          }

          imageUrl = URL.createObjectURL(sourceFile)
          const dimensions = await new Promise((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
            image.onerror = () => reject(new Error('The selected file is not a readable image.'))
            image.src = imageUrl
          })
          if (cancelled) return

          bounds = readWorldFile(await worldFile.text(), dimensions.width, dimensions.height)
          crs = 'EPSG:4326'
          layer = L.imageOverlay(imageUrl, bounds, { opacity: 0.9, pane: 'rasterPane' })
        }

        if (!bounds.isValid()) throw new Error('This file does not contain a usable geographic extent.')

        layer.addTo(map)
        rasterLayer.current = layer
        map.fitBounds(bounds, { padding: [52, 52], maxZoom: 16, animate: true })
        setRasterInfo({ crs, bounds })
        setImportState('ready')
        setImportMessage(isDxf(sourceFile)
          ? 'DXF converted from EPSG:26331 to WGS 84 GeoJSON'
          : isGeoTiff(sourceFile) ? 'Georeferencing read from the file' : 'Location read from the world file')
      } catch (error) {
        if (cancelled) return
        setImportState('error')
        setImportMessage(error instanceof Error ? error.message : 'Unable to read this GeoTIFF.')
      }
    }

    addOverlay()

    return () => {
      cancelled = true
      if (layer && map.hasLayer(layer)) map.removeLayer(layer)
      if (rasterLayer.current === layer) rasterLayer.current = null
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [sourceFile, worldFile])

  function chooseFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return

    if (files.some((file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf')) {
      setImportState('error')
      setImportMessage('GeoPDF reading is not available in this browser build. Convert it to GeoTIFF to keep the embedded map location.')
      return
    }
    const drawing = files.find(isDxf)
    if (drawing) {
      setWorldFile(null)
      setImportMessage('')
      setSourceFile(drawing)
      return
    }
    const image = files.find((file) => isGeoTiff(file) || isSupportedImage(file))
    if (!image) {
      setImportState('error')
      setImportMessage('Choose a GeoTIFF or PNG, JPG, GIF, or BMP image.')
      return
    }

    const matchingWorldFile = files.find((file) => (
      isWorldFile(file) && imageStem(file) === imageStem(image)
    ))
    setWorldFile(isGeoTiff(image) ? null : matchingWorldFile || null)
    setImportMessage('')
    setSourceFile(image)
  }

  function handleDrop(event) {
    event.preventDefault()
    setIsDragging(false)
    chooseFiles(event.dataTransfer.files)
  }

  function fitToBounds() {
    if (rasterInfo?.bounds) mapInstance.current?.fitBounds(rasterInfo.bounds, { padding: [52, 52], maxZoom: 16 })
  }

  function selectBasemap(nextBasemap) {
    const map = mapInstance.current
    const nextLayer = basemapLayers.current[nextBasemap]
    if (!map || !nextLayer || nextBasemap === basemap) return

    Object.values(basemapLayers.current).forEach((layer) => {
      if (map.hasLayer(layer)) map.removeLayer(layer)
    })
    nextLayer.addTo(map)
    setBasemap(nextBasemap)
  }

  function clearFile() {
    setSourceFile(null)
    setWorldFile(null)
    setRasterInfo(null)
    setImportState('idle')
    setImportMessage('')
    if (fileInput.current) fileInput.current.value = ''
  }

  const overlayReady = importState === 'ready'

  return (
    <main className={`workspace ${isPanelCollapsed ? 'panel-collapsed' : ''}`}>
      <aside className="control-rail" id="control-rail">
        <header className="brand-row">
          <div className="brand-mark" aria-hidden="true"><MapPinned size={18} strokeWidth={1.8} /></div>
          <div className="brand-copy">
            <span className="brand-name">FIELDNOTE</span>
            <span className="brand-product">IMAGE REGISTER</span>
          </div>
          <span className="version-tag">MAP 01</span>
        </header>

        <section className="panel-heading">
          <p className="eyebrow">GEOSPATIAL WORKSPACE</p>
          <h1>Geospatial overlay</h1>
          <p className="panel-description">Open a GeoTIFF or convert a DXF drawing for the map.</p>
        </section>

        <section className="control-section" aria-labelledby="image-label">
          <div className="section-title-row">
            <h2 id="image-label">Geospatial file</h2>
            <span className={`step-number ${overlayReady ? 'step-done' : ''}`}>{overlayReady ? <Check size={12} /> : '01'}</span>
          </div>

          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            accept=".dxf,.tif,.tiff,.png,.jpg,.jpeg,.gif,.bmp,.pgw,.pngw,.jgw,.jpgw,.jpegw,.gfw,.gifw,.bpw,.bmpw,.wld,.pdf"
            multiple
            onChange={(event) => {
              chooseFiles(event.target.files)
              event.target.value = ''
            }}
          />

          {sourceFile ? (
            <div className="file-card">
              <div className="file-icon"><FileImage size={19} /></div>
              <div className="file-details">
                <span className="file-name" title={sourceFile.name}>{sourceFile.name}</span>
                <span className="file-size">{formatFileSize(sourceFile.size)} · {rasterInfo?.crs || (importState === 'loading' ? 'reading metadata' : 'file selected')}</span>
              </div>
              <button className="icon-button remove-button" type="button" onClick={clearFile} aria-label="Remove file" title="Remove file">
                <Trash2 size={16} />
              </button>
            </div>
          ) : (
            <button
              className={`dropzone ${isDragging ? 'dropzone-active' : ''}`}
              type="button"
              onClick={() => fileInput.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              aria-label="Choose or drop a DXF, GeoTIFF, or georeferenced image with its world file"
            >
              <span className="upload-symbol"><Upload size={19} strokeWidth={1.8} /></span>
              <span className="dropzone-title">Drop a geospatial file here</span>
              <span className="dropzone-note">or <span className="browse-link">browse files <ArrowUpRight size={12} /></span></span>
              <span className="file-types">DXF · GEOTIFF · PNG · JPG · GIF · BMP</span>
            </button>
          )}
          {importMessage && <p className={`field-error ${importState === 'loading' ? 'field-progress' : ''}`}><AlertCircle size={14} />{importMessage}</p>}
        </section>

        <section className="control-section bounds-section" aria-labelledby="metadata-label">
          <div className="section-title-row">
            <div>
              <h2 id="metadata-label">Embedded georeferencing</h2>
              <p className="section-caption">Read automatically from the raster</p>
            </div>
            <span className={`step-number ${overlayReady ? 'step-done' : ''}`}>{overlayReady ? <Check size={12} /> : '02'}</span>
          </div>
          <p className="field-hint">DXF coordinates are assumed to be EPSG:26331 and converted to WGS 84 GeoJSON by the backend. GeoTIFF metadata and image world files are also supported.</p>
        </section>

        <div className="rail-spacer" />

        <section className={`readiness ${overlayReady ? 'readiness-live' : ''}`} aria-live="polite">
          <span className="readiness-dot" />
          <div>
            <strong>{overlayReady ? 'Overlay positioned' : importState === 'loading' ? 'Reading raster' : importState === 'error' ? 'Import needs attention' : 'Waiting for a raster'}</strong>
            <span>{overlayReady ? `${rasterInfo?.crs} · map fitted to extent` : importState === 'loading' ? 'Reading file coordinates' : 'Import a georeferenced GeoTIFF'}</span>
          </div>
          {overlayReady && <Check size={16} className="readiness-check" />}
        </section>

        <footer className="rail-footer">
          <span>FIELDNOTE / 2026</span>
          <span>© OpenStreetMap</span>
        </footer>
      </aside>

      <section className="map-stage" aria-label="Image overlay map">
        <div className="map-toolbar">
          <div className="map-location">
            <button
              className="panel-toggle"
              type="button"
              onClick={() => setIsPanelCollapsed((collapsed) => !collapsed)}
              aria-label={isPanelCollapsed ? 'Show controls' : 'Hide controls'}
              aria-controls="control-rail"
              aria-expanded={!isPanelCollapsed}
              title={isPanelCollapsed ? 'Show controls' : 'Hide controls'}
            >
              {isPanelCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
            <span className="map-status-mark" />
            <span>{overlayReady ? 'OVERLAY VIEW' : 'BASEMAP VIEW'}</span>
          </div>
          <div className="map-tools">
            <div className="basemap-switch" role="group" aria-label="Basemap">
              <button
                className={`basemap-option ${basemap === 'streets' ? 'basemap-option-active' : ''}`}
                type="button"
                onClick={() => selectBasemap('streets')}
                aria-pressed={basemap === 'streets'}
                title="Street map"
              >
                <MapIcon size={14} />
                <span>Streets</span>
              </button>
              <button
                className={`basemap-option ${basemap === 'satellite' ? 'basemap-option-active' : ''}`}
                type="button"
                onClick={() => selectBasemap('satellite')}
                aria-pressed={basemap === 'satellite'}
                title="Satellite imagery"
              >
                <Satellite size={14} />
                <span>Satellite</span>
              </button>
            </div>
            <span className="coordinate-system">{rasterInfo?.crs || 'AUTO CRS'}</span>
            <button className="fit-button" type="button" onClick={fitToBounds} disabled={!overlayReady} title="Fit map to raster extent">
              <LocateFixed size={15} />
              <span>Fit bounds</span>
            </button>
          </div>
        </div>
        <div ref={mapElement} className="map-canvas" />
        {!overlayReady && (
          <div className="map-empty-state" aria-hidden="true">
            <span className="empty-map-icon"><MapPinned size={19} /></span>
            <span>{importState === 'loading' ? 'Reading embedded raster coordinates' : 'Waiting for georeferenced raster'}</span>
          </div>
        )}
        {overlayReady && (
          <div className="map-legend">
            <span className="legend-swatch" />
            <span>{sourceFile.name}</span>
          </div>
        )}
      </section>
    </main>
  )
}
