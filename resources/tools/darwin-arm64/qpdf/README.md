# Bundled qpdf

Official qpdf 12.4.2 macOS ARM64 binary distribution.

Run `bin/qpdf` using its absolute path. Keep the adjacent `lib/` directory
and its symlink: the executable loads the bundled libqpdf dynamic library.
Only the qpdf executable and its runtime libraries are included; the upstream
fix-qdf and zlib-flate utilities are omitted.

Source, download checksums and binary hashes are recorded in the parent
`manifest.json`. Preserve LICENSE.txt and NOTICE.md when distributing.
