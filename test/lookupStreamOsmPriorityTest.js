const tape = require('tape');
const through = require('through2');
const Document = require('pelias-model').Document;
const lookupStream = require('../src/lookupStream');

// Mock PIP resolver that always returns the same WOF data
function createMockResolver() {
  return {
    lookup: function(centroid, layers, callback) {
      // Return mock WOF data
      const result = {
        country: [{
          id: 85633111,
          name: 'Poland',
          abbr: 'PL'
        }],
        region: [{
          id: 85687991,
          name: 'Małopolskie',
          abbr: null
        }],
        locality: [{
          id: 101752697,
          name: 'Nowa Huta',
          abbr: null
        }]
      };
      
      setTimeout(() => callback(null, result), 10);
    }
  };
}

function test_stream(input, testedStream, callback) {
  const input_stream = through.obj();
  const results = [];
  
  const destination_stream = through.obj(
    function(doc, enc, next) {
      results.push(doc);
      next();
    },
    function(done) {
      callback(null, results);
      done();
    }
  );

  input_stream
    .pipe(testedStream)
    .pipe(destination_stream);

  input.forEach(function(doc) {
    input_stream.write(doc);
  });

  input_stream.end();
}

tape('lookupStream with OSM priority: document without OSM admin uses WOF', function(t) {
  const doc = new Document('openstreetmap', 'venue', '1')
    .setCentroid({ lat: 50.0614, lon: 19.9383 });

  const mockResolver = createMockResolver();
  const stream = lookupStream(mockResolver, {});

  test_stream([doc], stream, function(err, results) {
    t.false(err, 'no error');
    t.equal(results.length, 1, 'one document returned');
    
    const actual = results[0];
    t.equal(actual.parent.locality[0], 'Nowa Huta', 'locality from WOF');
    t.equal(actual.parent.region[0], 'Małopolskie', 'region from WOF');
    t.equal(actual.parent.country[0], 'Poland', 'country from WOF');
    t.end();
  });
});

tape('lookupStream with OSM priority: document with OSM locality keeps it', function(t) {
  const doc = new Document('openstreetmap', 'venue', '1')
    .setCentroid({ lat: 50.0614, lon: 19.9383 });
  
  // Pre-populate locality from OSM
  doc.addParent('locality', 'Kraków', null, null);
  doc.setMeta('osmAdminFields', ['locality']);

  const mockResolver = createMockResolver();
  const stream = lookupStream(mockResolver, {});

  test_stream([doc], stream, function(err, results) {
    t.false(err, 'no error');
    t.equal(results.length, 1, 'one document returned');
    
    const actual = results[0];
    t.equal(actual.parent.locality[0], 'Kraków', 'locality from OSM not overwritten');
    t.equal(actual.parent.region[0], 'Małopolskie', 'region from WOF');
    t.equal(actual.parent.country[0], 'Poland', 'country from WOF');
    t.end();
  });
});

tape('lookupStream with OSM priority: document with all OSM admin keeps them all', function(t) {
  const doc = new Document('openstreetmap', 'venue', '1')
    .setCentroid({ lat: 50.0614, lon: 19.9383 });
  
  // Pre-populate all admin fields from OSM
  doc.addParent('locality', 'Kraków', null, null);
  doc.addParent('region', 'Lesser Poland', null, null);
  doc.addParent('country', 'Polska', null, null);
  doc.setMeta('osmAdminFields', ['locality', 'region', 'country']);

  const mockResolver = createMockResolver();
  const stream = lookupStream(mockResolver, {});

  test_stream([doc], stream, function(err, results) {
    t.false(err, 'no error');
    t.equal(results.length, 1, 'one document returned');
    
    const actual = results[0];
    t.equal(actual.parent.locality[0], 'Kraków', 'locality from OSM not overwritten');
    t.equal(actual.parent.region[0], 'Lesser Poland', 'region from OSM not overwritten');
    t.equal(actual.parent.country[0], 'Polska', 'country from OSM not overwritten');
    t.end();
  });
});

tape('lookupStream with OSM priority: mixed data (city from OSM, others from WOF)', function(t) {
  const doc = new Document('openstreetmap', 'venue', '1')
    .setCentroid({ lat: 50.0614, lon: 19.9383 });
  
  // Only locality from OSM
  doc.addParent('locality', 'Kraków', null, null);
  doc.setMeta('osmAdminFields', ['locality']);

  const mockResolver = createMockResolver();
  const stream = lookupStream(mockResolver, {});

  test_stream([doc], stream, function(err, results) {
    t.false(err, 'no error');
    t.equal(results.length, 1, 'one document returned');
    
    const actual = results[0];
    t.equal(actual.parent.locality[0], 'Kraków', 'locality from OSM');
    t.equal(actual.parent.region[0], 'Małopolskie', 'region from WOF');
    t.equal(actual.parent.country[0], 'Poland', 'country from WOF');
    
    // Verify only locality was marked as from OSM
    const osmFields = actual.getMeta('osmAdminFields');
    t.true(osmFields.includes('locality'), 'locality marked as from OSM');
    t.false(osmFields.includes('region'), 'region not marked as from OSM');
    t.false(osmFields.includes('country'), 'country not marked as from OSM');
    t.end();
  });
});

tape('lookupStream with OSM priority: empty osmAdminFields array', function(t) {
  const doc = new Document('openstreetmap', 'venue', '1')
    .setCentroid({ lat: 50.0614, lon: 19.9383 });
  
  // Set empty osmAdminFields metadata
  doc.setMeta('osmAdminFields', []);

  const mockResolver = createMockResolver();
  const stream = lookupStream(mockResolver, {});

  test_stream([doc], stream, function(err, results) {
    t.false(err, 'no error');
    t.equal(results.length, 1, 'one document returned');
    
    const actual = results[0];
    t.equal(actual.parent.locality[0], 'Nowa Huta', 'locality from WOF');
    t.equal(actual.parent.region[0], 'Małopolskie', 'region from WOF');
    t.equal(actual.parent.country[0], 'Poland', 'country from WOF');
    t.end();
  });
});

