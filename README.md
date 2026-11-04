# Fieldnote Image Register

A React and Leaflet workspace for opening georeferenced files over OpenStreetMap or satellite imagery. GeoTIFF metadata and image world files are read locally. DXF files are converted by the Python backend to WGS 84 GeoJSON and added as a vector layer.

## Run locally

Requires Node.js 18 or newer and Python 3.10 or newer.

```powershell
npm install
npm run dev
```

In a second terminal, start the conversion API:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend/requirements.txt
uvicorn backend.main:app --reload --port 8000
```

Upload a `.dxf` file in the app; its drawing coordinates are assumed to be EPSG:26331 (Minna / UTM zone 31N), transformed to EPSG:4326, and returned as GeoJSON. GeoTIFFs use embedded georeferencing. PNG, JPG, GIF, and BMP require a matching WGS 84 world file. GeoPDF import is not supported; convert it to GeoTIFF with georeferencing preserved.
