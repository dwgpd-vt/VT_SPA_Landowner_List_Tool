# Source Protection Area Landowner List Tool

This app helps a water-system operator or planner identify the Parcels that intersect with a Source Protection Areas (SPA).

IT is designed to support water system staff in the preparation of a Source Protection Plan and to generate a list of landowners to outreach and education.  Users can enter a WSID, see the matching SPA polygons on a map, review the intersecting parcels in a table, and export the list to CSV or XLSX.

## What the app does

- Accepts a WSID or a partial WSID
- Resolves the correct WSID from public Vermont GIS data
- Finds the matching Ground Water and/or Surface Water SPA polygons
- Identifies parcels intersecting those SPA polygons
- Displays the results in a table and on a map
- Exports the parcel list as CSV or Excel

## Data sources

The app queries live public ArcGIS services directly in the browser. It does not store or proxy user data in a backend.

| Data | Link |
| --- | --- |
| ANR Ground Water SPA | [Feature Service](https://anrmaps.vermont.gov/arcgis/rest/services/ANR/ANR_Atlas/MapServer/7) |
| ANR Surface Water SPA | [Feature Service](https://anrmaps.vermont.gov/arcgis/rest/services/ANR/ANR_Atlas/MapServer/13) |
| ANR Public Water Sources | [Feature Service](https://anrmaps.vermont.gov/arcgis/rest/services/ANR/ANR_Atlas/MapServer/4) |
| VCGI Statewide Parcels | [Feature Service](https://maps.vcgi.vermont.gov/arcgis/rest/services/VCGI_OPENDATA/VCGI_OpenData_Cadastral/MapServer/0) |

The service URLs and export field list are defined in `core.js`.

## Files in this project

| File | Purpose |
| --- | --- |
| `index.html` | Main application page |
| `style.css` | Layout, map styling, table styling, and controls |
| `app.js` | User interface logic, map rendering, autocomplete, and exports |
| `core.js` | WSID matching, SPA queries, parcel intersection logic, and CSV/XLSX builders |
| `vendor/` | Third-party libraries used by the app |
| `assets/` | Images and static files |

## How it works

1. The user enters a WSID.
2. The app searches the ArcGIS SPA layers for matching features.
3. It loads any related public water-source locations.
4. It intersects the SPA polygons with the parcel layer.
5. Matching parcels are de-duplicated and displayed in a table.
6. The user can export the table as CSV or XLSX.

## Notes and limitations

- This is a static front-end; there is no backend database.
- It depends on the live ArcGIS services being available and returning data correctly.
- Very large or highly complex SPA polygons may exceed service/browser limits and will fail gracefully with a message.
- Parcel data are general in nature and not survey-grade boundary data.
