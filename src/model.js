// # Recline Backbone Models
this.recline = this.recline || {};
this.recline.Model = this.recline.Model || {};

(function(my) {
  "use strict";

// use either jQuery or Underscore Deferred depending on what is available
var Deferred = (typeof jQuery !== "undefined" && jQuery.Deferred) || _.Deferred;

// ## <a id="dataset">Dataset</a>
my.Dataset = Backbone.Model.extend({
  constructor: function Dataset() {
    Backbone.Model.prototype.constructor.apply(this, arguments);
  },

  // ### initialize
  initialize: function() {
    var self = this;
    _.bindAll(this, 'query');
    this.backend = null;
    if (this.get('backend')) {
      this.backend = this._backendFromString(this.get('backend'));
    } else { // try to guess backend ...
      if (this.get('records')) {
        this.backend = recline.Backend.Memory;
      }
    }
    this.fields = new my.FieldList();
    this.records = new my.RecordList();
    this._changes = {
      deletes: [],
      updates: [],
      creates: []
    };
    this.facets = new my.FacetList();
    this.recordCount = null;
    this.queryState = new my.Query();
    this.queryState.bind('change facet:add', function () {
      self.query(); // We want to call query() without any arguments.
    });
    // store is what we query and save against
    // store will either be the backend or be a memory store if Backend fetch
    // tells us to use memory store
    this._store = this.backend;
    if (this.backend == recline.Backend.Memory) {
      this.fetch();
    }
  },

  // ### fetch
  //
  // Retrieve dataset and (some) records from the backend.
  fetch: function() {
    var self = this;
    var dfd = new Deferred();

    if (this.backend !== recline.Backend.Memory) {
      this.backend.fetch(this.toJSON())
        .done(handleResults)
        .fail(function(args) {
          dfd.reject(args);
        });
    } else {
      // special case where we have been given data directly
      handleResults({
        records: this.get('records'),
        fields: this.get('fields'),
        useMemoryStore: true
      });
    }

    function handleResults(results) {
      // if explicitly given the fields
      // (e.g. var dataset = new Dataset({fields: fields, ...})
      // use that field info over anything we get back by parsing the data
      // (results.fields)
      var fields = self.get('fields') || results.fields;

      var out = self._normalizeRecordsAndFields(results.records, fields);
      if (results.useMemoryStore) {
        self._store = new recline.Backend.Memory.Store(out.records, out.fields);
      }

      self.set(results.metadata);
      self.fields.reset(out.fields);
      self.query()
        .done(function() {
          dfd.resolve(self);
        })
        .fail(function(args) {
          dfd.reject(args);
        });
    }

    return dfd.promise();
  },

  // ### _normalizeRecordsAndFields
  // 
  // Get a proper set of fields and records from incoming set of fields and records either of which may be null or arrays or objects
  //
  // e.g. fields = ['a', 'b', 'c'] and records = [ [1,2,3] ] =>
  // fields = [ {id: a}, {id: b}, {id: c}], records = [ {a: 1}, {b: 2}, {c: 3}]
  _normalizeRecordsAndFields: function(records, fields) {
    // if no fields get them from records
    if (!fields && records && records.length > 0) {
      // records is array then fields is first row of records ...
      if (records[0] instanceof Array) {
        fields = records[0];
        records = records.slice(1);
      } else {
        fields = _.map(_.keys(records[0]), function(key) {
          return {id: key};
        });
      }
    } 

    // fields is an array of strings (i.e. list of field headings/ids)
    if (fields && fields.length > 0 && (fields[0] === null || typeof(fields[0]) != 'object')) {
      // Rename duplicate fieldIds as each field name needs to be
      // unique.
      var seen = {};
      fields = _.map(fields, function(field, index) {
        if (field === null) {
          field = '';
        } else {
          field = field.toString();
        }
        // cannot use trim as not supported by IE7
        var fieldId = field.replace(/^\s+|\s+$/g, '');
        if (fieldId === '') {
          fieldId = '_noname_';
          field = fieldId;
        }
        while (fieldId in seen) {
          seen[field] += 1;
          fieldId = field + seen[field];
        }
        if (!(field in seen)) {
          seen[field] = 0;
        }
        // TODO: decide whether to keep original name as label ...
        // return { id: fieldId, label: field || fieldId }
        return { id: fieldId };
      });
    }
    // records is provided as arrays so need to zip together with fields
    // NB: this requires you to have fields to match arrays
    if (records && records.length > 0 && records[0] instanceof Array) {
      records = _.map(records, function(doc) {
        var tmp = {};
        _.each(fields, function(field, idx) {
          tmp[field.id] = doc[idx];
        });
        return tmp;
      });
    }
    return {
      fields: fields,
      records: records
    };
  },

  save: function() {
    var self = this;
    // TODO: need to reset the changes ...
    return this._store.save(this._changes, this.toJSON());
  },

  // ### query
  //
  // AJAX method with promise API to get records from the backend.
  //
  // It will query based on current query state (given by this.queryState)
  // updated by queryObj (if provided).
  //
  // Resulting RecordList are used to reset this.records and are
  // also returned.
  query: function(queryObj) {
    var self = this;
    var dfd = new Deferred();
    this.trigger('query:start');

    if (queryObj) {
      this.queryState.set(queryObj, {silent: true});
    }
    var actualQuery = this.queryState.toJSON();

    this._store.query(actualQuery, this.toJSON())
      .done(function(queryResult) {
        self._handleQueryResult(queryResult);
        self.trigger('query:done');
        dfd.resolve(self.records);
      })
      .fail(function(args) {
        self.trigger('query:fail', args);
        dfd.reject(args);
      });
    return dfd.promise();
  },

  _handleQueryResult: function(queryResult) {
    var self = this;
    self.recordCount = queryResult.total;
    var docs = _.map(queryResult.hits, function(hit) {
      var _doc = new my.Record(hit);
      _doc.fields = self.fields;
      _doc.bind('change', function(doc) {
        self._changes.updates.push(doc.toJSON());
      });
      _doc.bind('destroy', function(doc) {
        self._changes.deletes.push(doc.toJSON());
      });
      return _doc;
    });
    self.records.reset(docs);
    if (queryResult.facets) {
      var facets = _.map(queryResult.facets, function(facetResult, facetId) {
        facetResult.id = facetId;
        return new my.Facet(facetResult);
      });
      self.facets.reset(facets);
    }
  },

  toTemplateJSON: function() {
    var data = this.toJSON();
    data.recordCount = this.recordCount;
    data.fields = this.fields.toJSON();
    return data;
  },

  // ### getFieldsSummary
  //
  // Get a summary for each field in the form of a `Facet`.
  // 
  // @return null as this is async function. Provides deferred/promise interface.
  getFieldsSummary: function() {
    var self = this;
    var query = new my.Query();
    query.set({size: 0});
    this.fields.each(function(field) {
      query.addFacet(field.id);
    });
    var dfd = new Deferred();
    this._store.query(query.toJSON(), this.toJSON()).done(function(queryResult) {
      if (queryResult.facets) {
        _.each(queryResult.facets, function(facetResult, facetId) {
          facetResult.id = facetId;
          var facet = new my.Facet(facetResult);
          // TODO: probably want replace rather than reset (i.e. just replace the facet with this id)
          self.fields.get(facetId).facets.reset(facet);
        });
      }
      dfd.resolve(queryResult);
    });
    return dfd.promise();
  },

  // Deprecated (as of v0.5) - use record.summary()
  recordSummary: function(record) {
    return record.summary();
  },

  // ### _backendFromString(backendString)
  //
  // Look up a backend module from a backend string (look in recline.Backend)
  _backendFromString: function(backendString) {
    var backend = null;
    if (recline && recline.Backend) {
      _.each(_.keys(recline.Backend), function(name) {
        if (name.toLowerCase() === backendString.toLowerCase()) {
          backend = recline.Backend[name];
        }
      });
    }
    return backend;
  }
});


// ## <a id="record">A Record</a>
// 
// A single record (or row) in the dataset
my.Record = Backbone.Model.extend({
  constructor: function Record() {
    Backbone.Model.prototype.constructor.apply(this, arguments);
  },

  // ### initialize
  // 
  // Create a Record
  //
  // You usually will not do this directly but will have records created by
  // Dataset e.g. in query method
  //
  // Certain methods require presence of a fields attribute (identical to that on Dataset)
  initialize: function() {
    _.bindAll(this, 'getFieldValue');
  },

  // ### getFieldValue
  //
  // For the provided Field get the corresponding rendered computed data value
  // for this record.
  //
  // NB: if field is undefined a default '' value will be returned
  getFieldValue: function(field) {
    var val = this.getFieldValueUnrendered(field);
    if (field && !_.isUndefined(field.renderer)) {
      val = field.renderer(val, field, this.toJSON());
    }
    return val;
  },

  // ### getFieldValueUnrendered
  //
  // For the provided Field get the corresponding computed data value
  // for this record.
  //
  // NB: if field is undefined a default '' value will be returned
  getFieldValueUnrendered: function(field) {
    if (!field) {
      return '';
    }
    var val = this.get(field.id);
    if (field.deriver) {
      val = field.deriver(val, field, this);
    }
    return val;
  },

  // ### summary
  //
  // Get a simple html summary of this record in form of key/value list
  summary: function(record) {
    var self = this;
    var html = '<div class="recline-record-summary">';
    this.fields.each(function(field) { 
      if (field.id != 'id') {
        html += '<div class="' + field.id + '"><strong>' + field.get('label') + '</strong>: ' + self.getFieldValue(field) + '</div>';
      }
    });
    html += '</div>';
    return html;
  },

  // Override Backbone save, fetch and destroy so they do nothing
  // Instead, Dataset object that created this Record should take care of
  // handling these changes (discovery will occur via event notifications)
  // WARNING: these will not persist *unless* you call save on Dataset
  fetch: function() {},
  save: function() {},
  destroy: function() { this.trigger('destroy', this); }
});


// ## A Backbone collection of Records
my.RecordList = Backbone.Collection.extend({
  constructor: function RecordList() {
    Backbone.Collection.prototype.constructor.apply(this, arguments);
  },
  model: my.Record
});


// ## <a id="field">A Field (aka Column) on a Dataset</a>
my.Field = Backbone.Model.extend({
  constructor: function Field() {
    Backbone.Model.prototype.constructor.apply(this, arguments);
  },
  // ### defaults - define default values
  defaults: {
    label: null,
    type: 'string',
    format: null,
    is_derived: false
  },
  // ### initialize
  //
  // @param {Object} data: standard Backbone model attributes
  //
  // @param {Object} options: renderer and/or deriver functions.
  initialize: function(data, options) {
    // if a hash not passed in the first argument throw error
    if ('0' in data) {
      throw new Error('Looks like you did not pass a proper hash with id to Field constructor');
    }
    if (this.attributes.label === null) {
      this.set({label: this.id});
    }
    if (this.attributes.type.toLowerCase() in this._typeMap) {
      this.attributes.type = this._typeMap[this.attributes.type.toLowerCase()];
    }
    if (options) {
      this.renderer = options.renderer;
      this.deriver = options.deriver;
    }
    if (!this.renderer) {
      this.renderer = data.renderer ? data.renderer : this.defaultRenderers[this.get('type')];
    }
    this.facets = new my.FacetList();
  },
  _typeMap: {
    'text': 'string',
    'double': 'number',
    'float': 'number',
    'numeric': 'number',
    'int': 'integer',
    'datetime': 'date-time',
    'bool': 'boolean',
    'timestamp': 'date-time',
    'json': 'object'
  },
  defaultRenderers: {
    object: function(val, field, doc) {
      return JSON.stringify(val);
    },
    geo_point: function(val, field, doc) {
      return JSON.stringify(val);
    },
    'number': function(val, field, doc) {
      var format = field.get('format'); 
      if (format === 'percentage') {
        return val + '%';
      }
      return val;
    },
    'string': function(val, field, doc) {
      var format = field.get('format');
      if (format === 'markdown') {
        if (typeof Showdown !== 'undefined') {
          var showdown = new Showdown.converter();
          out = showdown.makeHtml(val);
          return out;
        } else {
          return val;
        }
      } else if (format == 'plain') {
        return val;
      } else {
        // as this is the default and default type is string may get things
        // here that are not actually strings
        if (val && typeof val === 'string') {
          val = val.replace(/(https?:\/\/[^ ]+)/g, '<a href="$1">$1</a>');
        }
        return val;
      }
    }
  }
});

my.FieldList = Backbone.Collection.extend({
  constructor: function FieldList() {
    Backbone.Collection.prototype.constructor.apply(this, arguments);
  },
  model: my.Field
});

// ## <a id="query">Query</a>
my.Query = Backbone.Model.extend({
  constructor: function Query() {
    Backbone.Model.prototype.constructor.apply(this, arguments);
  },
  defaults: function() {
    return {
      size: 100,
      from: 0,
      q: '',
      facets: {},
      filters: []
    };
  },
  _filterTemplates: {
    term: {
      type: 'term',
      // TODO do we need this attribute here?
      field: '',
      term: ''
    },
    range: {
      type: 'range',
      start: '',
      stop: ''
    },
    geo_distance: {
      type: 'geo_distance',
      distance: 10,
      unit: 'km',
      point: {
        lon: 0,
        lat: 0
      }
    }
  },  
  // ### addFilter(filter)
  //
  // Add a new filter specified by the filter hash and append to the list of filters
  //
  // @param filter an object specifying the filter - see _filterTemplates for examples. If only type is provided will generate a filter by cloning _filterTemplates
  addFilter: function(filter) {
    // crude deep copy
    var ourfilter = JSON.parse(JSON.stringify(filter));
    // not fully specified so use template and over-write
    if (_.keys(filter).length <= 3) {
      ourfilter = _.defaults(ourfilter, this._filterTemplates[filter.type]);
    }
    var filters = this.get('filters');
    filters.push(ourfilter);
    this.trigger('change:filters:new-blank');
  },
  updateFilter: function(index, value) {
  },
  // ### removeFilter
  //
  // Remove a filter from filters at index filterIndex
  removeFilter: function(filterIndex) {
    var filters = this.get('filters');
    filters.splice(filterIndex, 1);
    this.set({filters: filters});
    this.trigger('change');
  },
  // ### addFacet
  //
  // Add a Facet to this query
  //
  // See <http://www.elasticsearch.org/guide/reference/api/search/facets/>
  addFacet: function(fieldId) {
    var facets = this.get('facets');
    // Assume id and fieldId should be the same (TODO: this need not be true if we want to add two different type of facets on same field)
    if (_.contains(_.keys(facets), fieldId)) {
      return;
    }
    facets[fieldId] = {
      terms: { field: fieldId }
    };
    this.set({facets: facets}, {silent: true});
    this.trigger('facet:add', this);
  },
  addHistogramFacet: function(fieldId) {
    var facets = this.get('facets');
    facets[fieldId] = {
      date_histogram: {
        field: fieldId,
        interval: 'day'
      }
    };
    this.set({facets: facets}, {silent: true});
    this.trigger('facet:add', this);
  }
});


// ## <a id="facet">A Facet (Result)</a>
my.Facet = Backbone.Model.extend({
  constructor: function Facet() {
    Backbone.Model.prototype.constructor.apply(this, arguments);
  },
  defaults: function() {
    return {
      _type: 'terms',
      total: 0,
      other: 0,
      missing: 0,
      terms: []
    };
  }
});

// ## A Collection/List of Facets
my.FacetList = Backbone.Collection.extend({
  constructor: function FacetList() {
    Backbone.Collection.prototype.constructor.apply(this, arguments);
  },
  model: my.Facet
});

// ## Object State
//
// Convenience Backbone model for storing (configuration) state of objects like Views.
my.ObjectState = Backbone.Model.extend({
});


// ## Backbone.sync
//
// Override Backbone.sync to hand off to sync function in relevant backend
Backbone.sync = function(method, model, options) {
  return model.backend.sync(method, model, options);
};

}(this.recline.Model));

