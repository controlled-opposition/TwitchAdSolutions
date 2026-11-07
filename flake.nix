{
  description = "TwitchAdSolutions (vaft) userscript";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.zst";

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs [
          "x86_64-linux"
          "aarch64-linux"
          "aarch64-darwin"
        ] (system: f nixpkgs.legacyPackages.${system});

      # `nix fmt`: one treefmt run over every file type that has a formatter.
      # Markdown is deliberately left alone (hand-wrapped prose).
      mkTreefmt =
        pkgs:
        pkgs.treefmt.withConfig {
          runtimeInputs = [
            pkgs.nixfmt
            pkgs.biome
            pkgs.yamlfmt
          ];
          settings = {
            tree-root-file = "flake.nix";
            on-unmatched = "debug";
            formatter = {
              nixfmt = {
                command = "nixfmt";
                includes = [ "*.nix" ];
              };
              # Formatting only; settings come from biome.json. Lint fixes stay a deliberate
              # `biome check --write`.
              biome = {
                command = "biome";
                options = [
                  "format"
                  "--write"
                  "--no-errors-on-unmatched"
                ];
                includes = [
                  "*.js"
                  "*.ts"
                  "*.json"
                ];
              };
              yamlfmt = {
                command = "yamlfmt";
                # Keep the blank lines that separate workflow steps.
                options = [
                  "-formatter"
                  "retain_line_breaks_single=true"
                ];
                includes = [
                  "*.yml"
                  "*.yaml"
                ];
              };
            };
          };
        };
    in
    {
      formatter = forAllSystems mkTreefmt;

      # `nix flake check` fails if anything is unformatted.
      checks = forAllSystems (pkgs: {
        formatting = (mkTreefmt pkgs).check self;
      });

      packages = forAllSystems (pkgs: {
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
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.typescript
            pkgs.biome
            self.packages.${pkgs.stdenv.hostPlatform.system}.acorn
            (mkTreefmt pkgs)
          ];
          # tests/load-vaft.js does require('acorn').
          NODE_PATH = "${self.packages.${pkgs.stdenv.hostPlatform.system}.acorn}/lib/node_modules";
          shellHook = ''
            echo "vaft dev shell — format: nix fmt (or treefmt) · lint: biome check --write . · types: tsc -p . · tests: node tests/test.js · syntax: acorn --ecma2022 vaft/vaft.user.js >/dev/null"
          '';
        };
      });
    };
}
