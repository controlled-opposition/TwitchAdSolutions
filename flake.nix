{
  description = "TwitchAdSolutions (vaft) userscript";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # acorn isn't in nixpkgs. It has no dependencies, so the npm tarball is enough.
          acorn = pkgs.stdenvNoCC.mkDerivation rec {
            pname = "acorn";
            version = "8.19.0";
            src = pkgs.fetchurl {
              url = "https://registry.npmjs.org/acorn/-/acorn-${version}.tgz";
              hash = "sha512-oJlA3XiRm7Cyk6qFD2Jn8ak9B7jSy0qy00ADO3+8dpT0LSjFihQYv4C02LFCSYJV3Q37xYwwRy5m+IpIiUzqWw==";
            };
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              mkdir -p $out/lib/node_modules/acorn $out/bin
              cp -r . $out/lib/node_modules/acorn
              makeWrapper ${pkgs.nodejs}/bin/node $out/bin/acorn \
                --add-flags $out/lib/node_modules/acorn/bin/acorn
            '';
            meta.mainProgram = "acorn";
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.typescript
              pkgs.biome
              self.packages.${system}.acorn
            ];
            # tests/load-vaft.js does require('acorn').
            NODE_PATH = "${self.packages.${system}.acorn}/lib/node_modules";
            shellHook = ''
              echo "vaft dev shell — lint+format: biome check --write . · types: tsc -p . · tests: node tests/test.js · syntax: acorn --ecma2022 vaft/vaft.user.js >/dev/null"
            '';
          };
        }
      );
    };
}
