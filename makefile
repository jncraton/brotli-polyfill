all: brotli.min.js

lint:
	npx prettier@3.6.2 --check .
	npx jshint@2.13.6
	
format:
	npx prettier@3.6.2 --write .

brotli.min.js: main.js
	npx uglify-js@3.19.3 --compress --mangle -- $< > $@
	wc -c $@

test: test.js
	node test.js

clean:
	rm -rf *.min.js
