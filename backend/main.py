from __future__ import annotations

import logging
import tempfile
from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

import ezdxf
from ezdxf.addons import geo
from ezdxf.math import Vec3
from fastapi import FastAPI, File, HTTPException, UploadFile
from pyproj import Transformer

LOGGER = logging.getLogger(__name__)
SOURCE_CRS = "EPSG:26331"
TARGET_CRS = "EPSG:4326"
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_FEATURES = 100_000
MAX_INSERT_DEPTH = 8
SUPPORTED_GEOMETRIES = {
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection",
}

app = FastAPI(title="Fieldnote DXF conversion API")


def iter_entities(entities: Iterable[Any], depth: int = 0) -> Iterator[Any]:
    for entity in entities:
        if entity.dxftype() != "INSERT":
            yield entity
            continue
        if depth >= MAX_INSERT_DEPTH:
            continue
        try:
            yield from iter_entities(entity.virtual_entities(), depth + 1)
        except Exception:
            LOGGER.warning("Could not expand a DXF block reference")


def entity_to_feature(entity: Any, transformer: Transformer) -> dict[str, Any] | None:
    try:
        if entity.dxftype() in {"TEXT", "MTEXT"}:
            location = entity.dxf.insert
            longitude, latitude = transformer.transform(location.x, location.y, errcheck=True)
            geometry = {"type": "Point", "coordinates": (longitude, latitude)}
        else:
            proxy = geo.proxy(entity, distance=0.25)

            def transform_point(point: Vec3) -> Vec3:
                longitude, latitude = transformer.transform(point.x, point.y, errcheck=True)
                return Vec3(longitude, latitude)

            proxy.apply(transform_point)
            geometry = proxy.__geo_interface__
    except (AttributeError, TypeError, ValueError, ezdxf.DXFError):
        return None

    if geometry.get("type") not in SUPPORTED_GEOMETRIES:
        return None

    properties: dict[str, Any] = {
        "layer": str(entity.dxf.get("layer", "0")),
        "entity_type": entity.dxftype(),
    }
    handle = entity.dxf.get("handle")
    if handle:
        properties["handle"] = str(handle)
    if entity.dxftype() in {"TEXT", "MTEXT"}:
        properties["text"] = str(entity.dxf.get("text", ""))

    return {"type": "Feature", "geometry": geometry, "properties": properties}


def convert_document(document: ezdxf.document.Drawing) -> dict[str, Any]:
    transformer = Transformer.from_crs(SOURCE_CRS, TARGET_CRS, always_xy=True)
    features: list[dict[str, Any]] = []

    for entity in iter_entities(iter(document.modelspace())):
        feature = entity_to_feature(entity, transformer)
        if feature is None:
            continue
        features.append(feature)
        if len(features) > MAX_FEATURES:
            raise ValueError(f"Drawing exceeds the {MAX_FEATURES:,} feature limit.")

    if not features:
        raise ValueError("No supported vector entities were found in the DXF modelspace.")

    return {
        "type": "FeatureCollection",
        "source_crs": SOURCE_CRS,
        "target_crs": TARGET_CRS,
        "features": features,
    }


def convert_dxf_bytes(contents: bytes) -> dict[str, Any]:
    if not contents:
        raise ValueError("The uploaded DXF file is empty.")

    with tempfile.TemporaryDirectory(prefix="fieldnote-dxf-") as temp_dir:
        dxf_path = Path(temp_dir) / "upload.dxf"
        dxf_path.write_bytes(contents)
        document = ezdxf.readfile(dxf_path)
        return convert_document(document)


@app.post("/api/convert-dxf")
async def convert_dxf(file: UploadFile = File(...)) -> dict[str, Any]:
    if Path(file.filename or "").suffix.lower() != ".dxf":
        raise HTTPException(status_code=415, detail="Upload a .dxf file.")

    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="DXF files must be 30 MB or smaller.")
    if not contents:
        raise HTTPException(status_code=400, detail="The uploaded DXF file is empty.")

    try:
        return convert_dxf_bytes(contents)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:
        LOGGER.exception("DXF conversion failed")
        raise HTTPException(
            status_code=422,
            detail="Could not read this DXF. Check that the file is valid and contains supported modelspace entities.",
        ) from error
    finally:
        await file.close()