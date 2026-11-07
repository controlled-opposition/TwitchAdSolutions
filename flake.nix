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
            # Build output (scripts/build.js), not hand-formatted.
            excludes = [ "vaft/vaft.user.js" ];
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

      # `nix flake check` runs the whole suite. Each check gets a writable copy of the source.
      checks = forAllSystems (
        pkgs:
        let
          runCheck =
            name: tools: script:
            pkgs.runCommand "vaft-${name}" { nativeBuildInputs = tools; } ''
              cp -r ${self} source
              chmod -R u+w source
              cd source
              ${script}
              touch $out
            '';
        in
        {
          formatting = (mkTreefmt pkgs).check self;
          lint = runCheck "lint" [ pkgs.biome ] "biome ci --vcs-enabled=false .";
          typecheck = runCheck "typecheck" [ pkgs.typescript ] "tsc -p . && tsc -p src/worker";
          # vaft/vaft.user.js is committed; it must be exactly what the sources build to.
          build = runCheck "build" [
            pkgs.nodejs
            pkgs.esbuild
          ] "node scripts/build.js --check";
          tests = runCheck "tests" [
            pkgs.nodejs
            pkgs.esbuild
          ] "node tests/test.js";
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            pkgs.typescript
            pkgs.biome
            pkgs.esbuild
            (mkTreefmt pkgs)
          ];
          shellHook = ''
            echo "vaft dev shell — build: node scripts/build.js · tests: node tests/test.js · types: tsc -p . && tsc -p src/worker · lint: biome check --write . · format: nix fmt · everything: nix flake check"
          '';
        };
      });
    };
}
