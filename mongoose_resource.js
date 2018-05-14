var _ = require('underscore'),
    Class = require('sji'),
    Resource = require('./resource'),
    Validation = require('./mongoose_validation'),
    mongoose = require("mongoose");

var MongooseResource = module.exports = Resource.extend({
    init: function (model) {
        this._super();
        this.model = model;
        this.default_filters = {};
        this.default_query = function (query) {
            return query;
        };
        this.validation = new Validation(model);
    },
    run_query: function (req, queryset, callback) {
        queryset.exec(callback);
    },

    show_fields: function () {
        return this.fields || _.map(this.model.schema.tree, function (value, key) {
                return key;
            });
    },

    get_object: function (req, id, callback) {
        var self = this;
        var query = this.default_query(this.model.findOne(this.default_filters));
        query = query.where('_id', id);
        this.authorization.limit_object(req, query, function (err, query) {
            if (err) callback(err);
            else {
                self.run_query(req, query, callback);
            }
        });
    },

    resolveFieldObject: function (obj) {
        const resolvedObj = {};
        Object.keys(obj).forEach(key => {
            const resolved = this.resolveField(key, obj[key]);
            if (resolved.op)
                resolvedObj[resolved.key] = {['$' + resolved.op]: resolved.value};
            else
                resolvedObj[resolved.key] = resolved.value;
        });
        return resolvedObj;
    },
    resolveValue: function (queryValue, queryOp, path) {
        if (Array.isArray(queryValue))
            return queryValue.map(val => this.resolveValue(val, queryOp, path));

        if (path) {
            if (path.options.type == Boolean)
                queryValue = typeof(queryValue) == 'string' ? queryValue.toLowerCase().trim() == 'true' : !!queryValue;
            else if (path.options.type == Number)
                queryValue = typeof(queryValue) == 'string' ? Number(queryValue.trim()) : Number(queryValue);
            else if (path.options.type && path.options.type.name === "ObjectId") {
                // console.log(path.schema);
                queryValue = mongoose.mongo.ObjectID(queryValue);
            }
        }
        if (queryOp == 'maxDistance')
            queryValue = Number(queryValue);
        return queryValue;
    },
    resolveField: function (queryKey, queryValue) {
        if (queryKey === "and") {
            return {
                key: "$and",
                value: queryValue.map(obj => this.resolveFieldObject(obj)),
            };
        } else if (queryKey === "or") {
            return {
                key: "$or",
                value: queryValue.map(obj => this.resolveFieldObject(obj)),
            };
        } else {
            const splt = queryKey.split('__');
            let queryOp = null;
            if (splt.length > 1) {
                queryKey = splt[0];
                queryOp = splt[1];
            }
            const path = this.model.schema.paths[queryKey];
            queryValue = this.resolveValue(queryValue, queryOp, path);
            return {
                op: queryOp,
                key: queryKey,
                value: queryValue,
            };
        }
    },
    get_objects: function (req, filters, sorts, limit, offset, callback) {
        var self = this;

        var query = this.default_query(this.model.find(this.default_filters));
        var count_query = this.model.count();

        Object.keys(filters).forEach((filterKey) => {
            const filterValue = filters[filterKey];
            const resolved = this.resolveField(filterKey, filterValue);
            if (resolved.key === "$or")
                query.or(resolved.value);
            else if (resolved.key === "$and")
                query.and(resolved.value);
            else if (resolved.op)
                query.where(resolved.key)[resolved.op](resolved.value);
            else
                query.where(resolved.key, resolved.value);
        });

        var defaultSort = query.options.sort || {};
        query.options.sort = {};

        for (var i = 0; i < sorts.length; i++) {
            var obj = {};
            obj[sorts[sorts.length - 1 - i].field] = sorts[sorts.length - 1 - i].type;
            query.sort(obj);
        }
        for (var key in defaultSort) {
            if (key in query.options.sort)
                continue;
            var obj = {};
            obj[key] = defaultSort[key];
            query.sort(obj);
        }

        //for(var i=0; i<default_sort.length; i++)
        //    query.options.sort.push(default_sort[i]);

        if (limit > 0)
            query.limit(limit);
        if (offset > 0)
            query.skip(offset);

        var results = null, count = null;

        function on_finish() {
            if (results != null && count != null) {
                var final = {
                    objects: results,
                    meta: {
                        total_count: count,
                        offset: offset,
                        limit: limit
                    }
                };
                callback(null, final);
            }
        }

        self.authorization.limit_object_list(req, query, function (err, query) {
            if (err) return callback(err);

            for (var key in query._conditions) {
                count_query._conditions[key] = query._conditions[key];
            }
            self.run_query(req, query, function (err, objects, counter) {
                if (err) callback(err);
                else {
                    results = objects;
                    if (!(limit > 0))
                        count = counter || objects.length;
                    on_finish();
                }
            });
            if (limit > 0) {
                self.run_query(req, count_query, function (err, counter) {
                    if (err) callback(err);
                    else {
                        count = counter;
                        on_finish();
                    }
                });
            }
        });

//        self.authorization.limit_object_list(req, count_query, function (err, count_query) {
//            if (err) callback(err);
//            else
//        });
    },

    create_obj: function (req, fields, callback) {
        var self = this;

        var object = new self.model();

        for (var field in fields) {
            object[field] = fields[field];
        }

        self.authorization.edit_object(req, object, function (err, object) {
            if (err) callback(err);
            else {
                object.save(function (err, object) {
                    callback(self.elaborate_mongoose_errors(err), object);
                });
            }
        });
    },

    update_obj: function (req, object, callback) {
        var self = this;

        self.authorization.edit_object(req, object, function (err, object) {
            if (err) callback(err);
            else {
                object.save(function (err, object) {
                    callback(self.elaborate_mongoose_errors(err), object);
                });
            }
        });
    },

    delete_obj: function (req, object, callback) {
        object.remove(function (err) {
            if (err) callback(err);
            else
                callback(null, {});
        });
    },

    elaborate_mongoose_errors: function (err) {
        if (err && err.errors) {
            for (var error in err.errors) {
                err.errors[error] = this.validation.elaborate_mongoose_error(error, err.errors[error]);
            }
        }
        return err;
    },

    /**
     * Sets values from fields in object
     * @param object
     * @param fields
     */
    setValues: function (object, fields) {
        var paths = {};
        var current_path = [];
        var iterateFields = function (fields) {
            _.each(fields, function (value, key) {
                current_path.push(key);
                if (value && typeof(value) == 'object' && !Array.isArray(value))
                    iterateFields(value);
                else
                    paths[current_path.join('.')] = value;
                current_path.pop();
            })

        };
        iterateFields(fields);
        this._super(object, paths);
        return object;
    }
});

