from __future__ import annotations

import ezdxf

from backend.main import convert_document, convert_dxf_bytes


def test_converts_minna_zone_31n_line_to_wgs84_geojson() -> None:
    document = ezdxf.new()
    document.modelspace().add_line((500_000, 0), (500_100, 0))

    feature_collection = convert_document(document)

    assert feature_collection["type"] == "FeatureCollection"
    assert feature_collection["source_crs"] == "EPSG:26331"
    assert feature_collection["target_crs"] == "EPSG:4326"
    feature = feature_collection["features"][0]
    assert feature["geometry"]["type"] == "LineString"
    assert abs(feature["geometry"]["coordinates"][0][0] - 3) < 0.02
    assert feature["properties"]["entity_type"] == "LINE"


def test_reads_uploaded_dxf_bytes(tmp_path) -> None:
    document = ezdxf.new()
    document.modelspace().add_point((500_000, 0))
    dxf_path = tmp_path / "sample.dxf"
    document.saveas(dxf_path)

    feature_collection = convert_dxf_bytes(dxf_path.read_bytes())

    assert feature_collection["features"][0]["geometry"]["type"] == "Point"
    assert abs(feature_collection["features"][0]["geometry"]["coordinates"][0] - 3) < 0.02